// SPDX-License-Identifier: AGPL-3.0-or-later

//! Builds and publishes echowire's own signed apt and rpm repositories.
//!
//! Packages come from the published desktop releases (or from local files), are copied into a
//! repository layout, indexed, signed with a key the operator supplies, and uploaded to the
//! downloads bucket that `fluxer_api` already serves at `/dl/apt/*` and `/dl/rpm/*`.
//!
//! The signing key is never generated or stored here. `build` resolves it from the environment
//! and fails with instructions when it is absent, and `publish` refuses a tree whose signatures
//! are missing, so an unsigned repository cannot reach the bucket by accident.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use clap::{Args, Subcommand};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::TempDir;

use crate::common::{
    CommandSpec, S3UploadPlanItem, collect_files, command_succeeds, download_file, env_string,
    output_bytes, remove_file_if_exists, require_any_env, run_command, s3_client,
    s3_content_type_for_key, upload_s3_plan_append_only, upload_s3_plan_overwrite,
};

const REPO_ORIGIN: &str = "echowire";
const REPO_LABEL: &str = "echowire";
const REPO_DESCRIPTION: &str = "echowire desktop packages";
const APT_COMPONENT: &str = "main";
const APT_ARCH: &str = "amd64";
const RPM_ARCH: &str = "x86_64";
const APT_TREE_DIRECTORY: &str = "apt";
const RPM_TREE_DIRECTORY: &str = "rpm";
const PUBLIC_KEY_FILENAME: &str = "echowire.asc";
const APT_SOURCES_FILENAME: &str = "echowire.sources";
const RPM_REPO_FILENAME: &str = "echowire.repo";
const KEYRING_INSTALL_PATH: &str = "/etc/apt/keyrings/echowire.asc";

const SIGNING_KEY_ENV: &str = "ECHOWIRE_REPO_SIGNING_KEY";
const SIGNING_KEY_FILE_ENV: &str = "ECHOWIRE_REPO_SIGNING_KEY_FILE";
const SIGNING_KEY_ID_ENV: &str = "ECHOWIRE_REPO_SIGNING_KEY_ID";
const SIGNING_PASSPHRASE_ENV: &str = "ECHOWIRE_REPO_SIGNING_PASSPHRASE";

const DEFAULT_PUBLIC_BASE_URL: &str = "https://echowire.org/api/dl";
const DEFAULT_CHANNELS: &str = "stable,canary";
const INDEX_CACHE_CONTROL: &str = "public, max-age=60";
const PACKAGE_CACHE_CONTROL: &str = "public, max-age=31536000";

#[derive(Debug, Args)]
pub(crate) struct LinuxRepoArgs {
    #[command(subcommand)]
    command: LinuxRepoCommand,
}

#[derive(Debug, Subcommand)]
enum LinuxRepoCommand {
    /// Build signed apt and rpm repository trees.
    Build(LinuxRepoBuildArgs),
    /// Upload a repository tree produced by `build` to the downloads bucket.
    Publish(LinuxRepoPublishArgs),
}

#[derive(Debug, Args)]
struct LinuxRepoBuildArgs {
    /// Directory the repository trees are written to.
    #[arg(long, default_value = "linux-repo")]
    out: PathBuf,
    /// Release channels to publish, each becoming an apt suite and an rpm directory.
    #[arg(long, value_delimiter = ',', default_value = DEFAULT_CHANNELS)]
    channels: Vec<String>,
    /// Download api base url used both to fetch packages and to write install snippets.
    #[arg(long, default_value = DEFAULT_PUBLIC_BASE_URL)]
    public_base_url: String,
    /// Use this local .deb instead of fetching one. Requires exactly one channel.
    #[arg(long)]
    deb: Vec<PathBuf>,
    /// Use this local .rpm instead of fetching one. Requires exactly one channel.
    #[arg(long)]
    rpm: Vec<PathBuf>,
    /// Skip the apt repository.
    #[arg(long)]
    skip_apt: bool,
    /// Skip the rpm repository, which needs createrepo_c and rpmsign on the host.
    #[arg(long)]
    skip_rpm: bool,
    /// Build the indexes without signing them. The result is deliberately unpublishable and
    /// exists only to check the layout on a host that has no signing key.
    #[arg(long)]
    unsigned: bool,
}

#[derive(Debug, Args)]
struct LinuxRepoPublishArgs {
    /// Directory produced by `build`.
    #[arg(long, default_value = "linux-repo")]
    root: PathBuf,
    /// Downloads bucket. Defaults to S3_DOWNLOADS_BUCKET or S3_BUCKET.
    #[arg(long)]
    bucket: Option<String>,
    /// Print the upload plan without uploading anything.
    #[arg(long)]
    dry_run: bool,
}

pub(crate) async fn run(args: LinuxRepoArgs) -> Result<()> {
    match args.command {
        LinuxRepoCommand::Build(args) => run_build(args).await,
        LinuxRepoCommand::Publish(args) => run_publish(args).await,
    }
}

#[derive(Debug, Deserialize)]
struct DesktopVersionResponse {
    version: String,
    files: std::collections::BTreeMap<String, DesktopVersionFile>,
}

#[derive(Debug, Deserialize)]
struct DesktopVersionFile {
    url: String,
    sha256: String,
}

#[derive(Debug)]
struct ChannelPackages {
    channel: String,
    debs: Vec<PathBuf>,
    rpms: Vec<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
struct DebFields {
    package: String,
    version: String,
    architecture: String,
}

async fn run_build(args: LinuxRepoBuildArgs) -> Result<()> {
    ensure!(
        !(args.skip_apt && args.skip_rpm),
        "Nothing to build: --skip-apt and --skip-rpm were both given"
    );
    let channels = validated_channels(&args.channels)?;
    let local_packages = !args.deb.is_empty() || !args.rpm.is_empty();
    ensure!(
        !local_packages || channels.len() == 1,
        "--deb and --rpm apply to a single channel, so pass exactly one --channels value"
    );
    let base_url = args.public_base_url.trim_end_matches('/').to_string();
    ensure!(!base_url.is_empty(), "--public-base-url must not be empty");

    let signing = if args.unsigned {
        println!(
            "WARNING: building unsigned indexes. The result cannot be published and must not be \
             served to clients."
        );
        None
    } else {
        Some(SigningContext::resolve()?)
    };

    let downloads = args.out.join("packages");
    let mut collected = Vec::new();
    for channel in &channels {
        collected.push(
            collect_channel_packages(
                channel,
                &base_url,
                &downloads,
                &args.deb,
                &args.rpm,
                args.skip_apt,
                args.skip_rpm,
            )
            .await?,
        );
    }

    if !args.skip_apt {
        let apt_root = args.out.join(APT_TREE_DIRECTORY);
        build_apt_tree(&apt_root, &collected, signing.as_ref())?;
        fs::write(
            apt_root.join(APT_SOURCES_FILENAME),
            apt_sources_file(&base_url, &channels),
        )
        .context("Failed to write the apt sources snippet")?;
        if let Some(signing) = signing.as_ref() {
            signing.export_public_key(&apt_root.join(PUBLIC_KEY_FILENAME))?;
        }
        println!("Built apt repository at {}", apt_root.display());
    }

    if !args.skip_rpm {
        let rpm_root = args.out.join(RPM_TREE_DIRECTORY);
        build_rpm_tree(&rpm_root, &collected, signing.as_ref())?;
        fs::write(
            rpm_root.join(RPM_REPO_FILENAME),
            rpm_repo_file(&base_url, &channels),
        )
        .context("Failed to write the rpm .repo snippet")?;
        if let Some(signing) = signing.as_ref() {
            signing.export_public_key(&rpm_root.join(PUBLIC_KEY_FILENAME))?;
        }
        println!("Built rpm repository at {}", rpm_root.display());
    }

    Ok(())
}

fn validated_channels(channels: &[String]) -> Result<Vec<String>> {
    let mut validated = Vec::new();
    for channel in channels {
        let channel = channel.trim();
        ensure!(
            !channel.is_empty()
                && channel.len() <= 32
                && channel
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
            "Channel {channel:?} is not a valid suite name: use lowercase letters, digits and dashes"
        );
        ensure!(
            !validated.contains(&channel.to_string()),
            "Channel {channel:?} was given twice"
        );
        validated.push(channel.to_string());
    }
    ensure!(!validated.is_empty(), "At least one channel is required");
    Ok(validated)
}

async fn collect_channel_packages(
    channel: &str,
    base_url: &str,
    downloads: &Path,
    local_debs: &[PathBuf],
    local_rpms: &[PathBuf],
    skip_apt: bool,
    skip_rpm: bool,
) -> Result<ChannelPackages> {
    if !local_debs.is_empty() || !local_rpms.is_empty() {
        for path in local_debs.iter().chain(local_rpms.iter()) {
            ensure!(path.is_file(), "{} is not a file", path.display());
        }
        println!("Using {} local packages for the {channel} channel", local_debs.len() + local_rpms.len());
        return Ok(ChannelPackages {
            channel: channel.to_string(),
            debs: local_debs.to_vec(),
            rpms: local_rpms.to_vec(),
        });
    }

    let url = format!("{base_url}/desktop/{channel}/linux/x64/latest");
    let response: DesktopVersionResponse = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .with_context(|| format!("Failed to read {url}"))?
        .error_for_status()
        .with_context(|| format!("Failed to read {url}"))?
        .json()
        .await
        .with_context(|| format!("Failed to parse the release descriptor from {url}"))?;

    let version = response.version.clone();
    let mut debs = Vec::new();
    let mut rpms = Vec::new();
    for (format, extension, wanted) in [("deb", "deb", !skip_apt), ("rpm", "rpm", !skip_rpm)] {
        if !wanted {
            continue;
        }
        let file = response.files.get(format).with_context(|| {
            format!("Release {version} of the {channel} channel publishes no {format}")
        })?;
        let target = downloads.join(channel).join(format!(
            "echowire-{channel}-{version}-linux.{extension}"
        ));
        fetch_verified(&file.url, &file.sha256, &target).await?;
        if format == "deb" {
            debs.push(target);
        } else {
            rpms.push(target);
        }
    }

    println!("Channel {channel} is at version {version}");
    Ok(ChannelPackages {
        channel: channel.to_string(),
        debs,
        rpms,
    })
}

async fn fetch_verified(url: &str, expected_sha256: &str, target: &Path) -> Result<()> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    ensure!(
        expected.len() == 64 && expected.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "The release descriptor gave {expected_sha256:?} instead of a sha256 for {url}"
    );
    if target.is_file() && file_sha256(target)? == expected {
        println!("Reusing verified {}", target.display());
        return Ok(());
    }
    println!("Fetching {url}");
    download_file(url, target).await?;
    let actual = file_sha256(target)?;
    ensure!(
        actual == expected,
        "Checksum mismatch for {url}: expected {expected}, got {actual}"
    );
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String> {
    let mut file =
        fs::File::open(path).with_context(|| format!("Failed to read {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn build_apt_tree(
    apt_root: &Path,
    channels: &[ChannelPackages],
    signing: Option<&SigningContext>,
) -> Result<()> {
    require_tool(
        "apt-ftparchive",
        "apt-utils",
        "the apt index generator, part of apt-utils on debian and ubuntu",
    )?;
    require_tool(
        "dpkg-deb",
        "dpkg",
        "needed to read the control fields of each package",
    )?;
    require_tool("gzip", "gzip", "needed to compress the Packages index")?;

    for channel in channels {
        ensure!(
            !channel.debs.is_empty(),
            "No .deb for the {} channel",
            channel.channel
        );
        let suite = &channel.channel;
        for deb in &channel.debs {
            let fields = deb_fields(deb)?;
            ensure!(
                fields.architecture == APT_ARCH,
                "{} declares architecture {} but this repository only publishes {APT_ARCH}",
                deb.display(),
                fields.architecture
            );
            let target = apt_root.join(pool_relative_path(suite, &fields));
            copy_into(deb, &target)?;
        }

        let binary_directory = apt_root
            .join("dists")
            .join(suite)
            .join(APT_COMPONENT)
            .join(format!("binary-{APT_ARCH}"));
        fs::create_dir_all(&binary_directory)
            .with_context(|| format!("Failed to create {}", binary_directory.display()))?;
        let packages_path = binary_directory.join("Packages");
        remove_file_if_exists(&packages_path)?;
        remove_file_if_exists(&binary_directory.join("Packages.gz"))?;
        let pool_directory = format!("pool/{suite}/{APT_COMPONENT}");
        let packages = output_bytes(
            CommandSpec::new("apt-ftparchive")
                .arg("packages")
                .arg(&pool_directory)
                .current_dir(apt_root),
        )
        .context("apt-ftparchive failed to index the pool")?;
        ensure!(
            !packages.is_empty(),
            "apt-ftparchive produced an empty Packages index for {pool_directory}"
        );
        fs::write(&packages_path, &packages)
            .with_context(|| format!("Failed to write {}", packages_path.display()))?;
        run_command(
            CommandSpec::new("gzip")
                .args(["-9", "-n", "-k", "-f"])
                .arg(&packages_path),
        )?;

        let suite_directory = apt_root.join("dists").join(suite);
        let release_path = suite_directory.join("Release");
        remove_file_if_exists(&release_path)?;
        remove_file_if_exists(&suite_directory.join("Release.gpg"))?;
        remove_file_if_exists(&suite_directory.join("InRelease"))?;
        let mut spec = CommandSpec::new("apt-ftparchive");
        for override_value in apt_release_overrides(suite) {
            spec = spec.arg("-o").arg(override_value);
        }
        let release = output_bytes(
            spec.arg("release")
                .arg(format!("dists/{suite}"))
                .current_dir(apt_root),
        )
        .context("apt-ftparchive failed to build the Release file")?;
        fs::write(&release_path, &release)
            .with_context(|| format!("Failed to write {}", release_path.display()))?;

        if let Some(signing) = signing {
            signing.detach_sign(&release_path, &suite_directory.join("Release.gpg"))?;
            signing.clear_sign(&release_path, &suite_directory.join("InRelease"))?;
        }
    }
    Ok(())
}

fn build_rpm_tree(
    rpm_root: &Path,
    channels: &[ChannelPackages],
    signing: Option<&SigningContext>,
) -> Result<()> {
    require_tool(
        "createrepo_c",
        "createrepo-c",
        "the rpm metadata generator; it is packaged for debian and ubuntu as createrepo-c",
    )?;
    if signing.is_some() {
        require_tool(
            "rpmsign",
            "rpm",
            "needed to sign each rpm so dnf can verify it with gpgcheck",
        )?;
    }

    for channel in channels {
        ensure!(
            !channel.rpms.is_empty(),
            "No .rpm for the {} channel",
            channel.channel
        );
        let arch_directory = rpm_root.join(&channel.channel).join(RPM_ARCH);
        for rpm in &channel.rpms {
            let filename = rpm
                .file_name()
                .with_context(|| format!("{} has no filename", rpm.display()))?;
            let target = arch_directory.join(filename);
            copy_into(rpm, &target)?;
            if let Some(signing) = signing {
                signing.sign_rpm(&target)?;
            }
        }
        run_command(
            CommandSpec::new("createrepo_c")
                .arg("--update")
                .arg(&arch_directory),
        )
        .context("createrepo_c failed to build the repodata")?;
        let repomd = arch_directory.join("repodata").join("repomd.xml");
        ensure!(
            repomd.is_file(),
            "createrepo_c did not produce {}",
            repomd.display()
        );
        if let Some(signing) = signing {
            let signature = arch_directory.join("repodata").join("repomd.xml.asc");
            remove_file_if_exists(&signature)?;
            signing.detach_sign(&repomd, &signature)?;
        }
    }
    Ok(())
}

fn require_tool(program: &str, package: &str, purpose: &str) -> Result<()> {
    if command_succeeds(CommandSpec::new(program).arg("--version")) {
        return Ok(());
    }
    bail!(
        "{program} is not installed on this host, and it is {purpose}.\nInstall it with `apt-get \
         install {package}` (or the equivalent for the host) and run the command again."
    )
}

fn copy_into(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    fs::copy(source, target).with_context(|| {
        format!(
            "Failed to copy {} to {}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn deb_fields(path: &Path) -> Result<DebFields> {
    let mut values = Vec::new();
    for field in ["Package", "Version", "Architecture"] {
        let value = String::from_utf8(output_bytes(
            CommandSpec::new("dpkg-deb").arg("--field").arg(path).arg(field),
        )?)
        .with_context(|| format!("dpkg-deb returned a non-utf8 {field} for {}", path.display()))?
        .trim()
        .to_string();
        ensure!(
            !value.is_empty(),
            "{} has no {field} control field",
            path.display()
        );
        ensure!(
            !value.contains('/') && !value.contains(".."),
            "{} has a {field} of {value:?}, which is not a safe path component",
            path.display()
        );
        values.push(value);
    }
    Ok(DebFields {
        package: values[0].clone(),
        version: values[1].clone(),
        architecture: values[2].clone(),
    })
}

fn pool_relative_path(suite: &str, fields: &DebFields) -> PathBuf {
    let initial = if fields.package.starts_with("lib") && fields.package.len() > 3 {
        &fields.package[..4]
    } else {
        &fields.package[..1]
    };
    // Debian strips the epoch from the filename, and our versions never carry one.
    let version = fields
        .version
        .split_once(':')
        .map_or(fields.version.as_str(), |(_, rest)| rest);
    PathBuf::from("pool")
        .join(suite)
        .join(APT_COMPONENT)
        .join(initial)
        .join(&fields.package)
        .join(format!(
            "{}_{version}_{}.deb",
            fields.package, fields.architecture
        ))
}

fn apt_release_overrides(suite: &str) -> Vec<String> {
    vec![
        format!("APT::FTPArchive::Release::Origin={REPO_ORIGIN}"),
        format!("APT::FTPArchive::Release::Label={REPO_LABEL}"),
        format!("APT::FTPArchive::Release::Suite={suite}"),
        format!("APT::FTPArchive::Release::Codename={suite}"),
        format!("APT::FTPArchive::Release::Architectures={APT_ARCH}"),
        format!("APT::FTPArchive::Release::Components={APT_COMPONENT}"),
        format!("APT::FTPArchive::Release::Description={REPO_DESCRIPTION} ({suite})"),
    ]
}

fn apt_sources_file(base_url: &str, channels: &[String]) -> String {
    let mut out = String::new();
    for channel in channels {
        if !out.is_empty() {
            out.push('\n');
        }
        let enabled = if channel == "stable" { "yes" } else { "no" };
        out.push_str(&format!(
            "Types: deb\nURIs: {base_url}/{APT_TREE_DIRECTORY}\nSuites: {channel}\nComponents: \
             {APT_COMPONENT}\nArchitectures: {APT_ARCH}\nSigned-By: \
             {KEYRING_INSTALL_PATH}\nEnabled: {enabled}\n"
        ));
    }
    out
}

fn rpm_repo_file(base_url: &str, channels: &[String]) -> String {
    let mut out = String::new();
    for channel in channels {
        if !out.is_empty() {
            out.push('\n');
        }
        let (id, name) = if channel == "stable" {
            ("echowire".to_string(), "echowire".to_string())
        } else {
            (
                format!("echowire-{channel}"),
                format!("echowire ({channel})"),
            )
        };
        let enabled = usize::from(channel == "stable");
        out.push_str(&format!(
            "[{id}]\nname={name}\nbaseurl={base_url}/{RPM_TREE_DIRECTORY}/{channel}/{RPM_ARCH}\nenabled={enabled}\ngpgcheck=1\nrepo_gpgcheck=1\ngpgkey={base_url}/{RPM_TREE_DIRECTORY}/{PUBLIC_KEY_FILENAME}\nmetadata_expire=300\n"
        ));
    }
    out
}

struct SigningContext {
    home: TempDir,
    key_id: String,
    passphrase_file: Option<PathBuf>,
}

impl SigningContext {
    fn resolve() -> Result<Self> {
        require_tool("gpg", "gnupg", "needed to sign the repository indexes")?;
        let material = match (
            env_string(SIGNING_KEY_FILE_ENV),
            env_string(SIGNING_KEY_ENV),
        ) {
            (Some(path), _) => fs::read(&path)
                .with_context(|| format!("Failed to read {SIGNING_KEY_FILE_ENV} at {path}"))?,
            (None, Some(inline)) => inline.into_bytes(),
            (None, None) => bail!(missing_signing_key_message()),
        };

        let home = tempfile::Builder::new()
            .prefix("echowire-repo-gnupg-")
            .tempdir()
            .context("Failed to create a temporary GNUPGHOME")?;
        set_private_permissions(home.path())?;
        let key_path = home.path().join("signing-key.asc");
        fs::write(&key_path, &material).context("Failed to stage the signing key")?;
        set_private_permissions(&key_path)?;

        let passphrase_file = match env_string(SIGNING_PASSPHRASE_ENV) {
            Some(passphrase) => {
                let path = home.path().join("passphrase");
                fs::write(&path, passphrase).context("Failed to stage the signing passphrase")?;
                set_private_permissions(&path)?;
                Some(path)
            }
            None => None,
        };

        let context = Self {
            home,
            key_id: String::new(),
            passphrase_file,
        };
        run_command(context.gpg().arg("--import").arg(&key_path)).context(
            "gpg could not import the signing key. Export it with `gpg --armor \
             --export-secret-keys <key>`",
        )?;
        fs::remove_file(&key_path).context("Failed to remove the staged signing key")?;

        let key_id = match env_string(SIGNING_KEY_ID_ENV) {
            Some(key_id) => key_id,
            None => sole_secret_key_id(&context)?,
        };
        Ok(Self { key_id, ..context })
    }

    fn gpg(&self) -> CommandSpec {
        let mut spec = CommandSpec::new("gpg")
            .arg("--homedir")
            .arg(self.home.path())
            .args(["--batch", "--yes", "--pinentry-mode", "loopback"])
            .env_remove("GPG_AGENT_INFO");
        if let Some(passphrase_file) = &self.passphrase_file {
            spec = spec.arg("--passphrase-file").arg(passphrase_file);
        }
        spec
    }

    fn detach_sign(&self, source: &Path, target: &Path) -> Result<()> {
        remove_file_if_exists(target)?;
        run_command(
            self.gpg()
                .args(["--digest-algo", "SHA512", "--armor", "--detach-sign"])
                .arg("--local-user")
                .arg(&self.key_id)
                .arg("--output")
                .arg(target)
                .arg(source),
        )
        .with_context(|| format!("Failed to sign {}", source.display()))
    }

    fn clear_sign(&self, source: &Path, target: &Path) -> Result<()> {
        remove_file_if_exists(target)?;
        run_command(
            self.gpg()
                .args(["--digest-algo", "SHA512", "--clearsign"])
                .arg("--local-user")
                .arg(&self.key_id)
                .arg("--output")
                .arg(target)
                .arg(source),
        )
        .with_context(|| format!("Failed to clearsign {}", source.display()))
    }

    fn sign_rpm(&self, package: &Path) -> Result<()> {
        let mut spec = CommandSpec::new("rpmsign")
            .arg("--addsign")
            .arg("--define")
            .arg(format!("_gpg_name {}", self.key_id))
            .arg("--define")
            .arg("_gpg_digest_algo sha256")
            .env("GNUPGHOME", self.home.path());
        if let Some(passphrase_file) = &self.passphrase_file {
            let passphrase = fs::read_to_string(passphrase_file)
                .context("Failed to read the staged signing passphrase")?;
            spec = spec.arg("--define").arg(format!(
                "__gpg_sign_cmd %{{__gpg}} gpg --batch --pinentry-mode loopback --passphrase {} \
                 --no-armor --no-secmem-warning -u \"%{{_gpg_name}}\" -sbo %{{__signature_filename}} \
                 %{{__plaintext_filename}}",
                passphrase.trim()
            ));
        }
        run_command(spec.arg(package))
            .with_context(|| format!("Failed to sign {}", package.display()))
    }

    fn export_public_key(&self, target: &Path) -> Result<()> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create {}", parent.display()))?;
        }
        let exported = output_bytes(
            self.gpg()
                .args(["--armor", "--export"])
                .arg(&self.key_id),
        )
        .context("Failed to export the public signing key")?;
        ensure!(
            !exported.is_empty(),
            "gpg exported an empty public key for {}",
            self.key_id
        );
        fs::write(target, exported)
            .with_context(|| format!("Failed to write {}", target.display()))
    }
}

fn sole_secret_key_id(context: &SigningContext) -> Result<String> {
    let listing = String::from_utf8(output_bytes(
        context
            .gpg()
            .args(["--list-secret-keys", "--with-colons"]),
    )?)
    .context("gpg returned a non-utf8 key listing")?;
    let fingerprints = secret_key_fingerprints(&listing);
    match fingerprints.as_slice() {
        [single] => Ok(single.clone()),
        [] => bail!(
            "The imported key material contains no secret key, so nothing can be signed. Export \
             it with `gpg --armor --export-secret-keys <key>`"
        ),
        many => bail!(
            "The imported key material contains {} secret keys. Set {SIGNING_KEY_ID_ENV} to the \
             fingerprint to use, one of: {}",
            many.len(),
            many.join(", ")
        ),
    }
}

fn secret_key_fingerprints(listing: &str) -> Vec<String> {
    let mut fingerprints = Vec::new();
    let mut in_secret_key = false;
    for line in listing.lines() {
        let mut fields = line.split(':');
        match fields.next() {
            Some("sec") => in_secret_key = true,
            Some("fpr") if in_secret_key => {
                if let Some(fingerprint) = fields.nth(8) {
                    fingerprints.push(fingerprint.to_string());
                }
                in_secret_key = false;
            }
            Some("ssb") | Some("pub") => in_secret_key = false,
            _ => {}
        }
    }
    fingerprints
}

fn missing_signing_key_message() -> String {
    format!(
        "No repository signing key is available, so the apt and rpm indexes cannot be signed.\n\n\
         Point {SIGNING_KEY_FILE_ENV} at an armored secret key file, or put the armored key in \
         {SIGNING_KEY_ENV}. Add {SIGNING_PASSPHRASE_ENV} when the key is protected, and \
         {SIGNING_KEY_ID_ENV} when the keyring holds more than one secret key.\n\n\
         To create the key once, on a machine you control:\n\
         \x20 gpg --quick-generate-key 'echowire package signing <packages@echowire.org>' rsa4096 \
         sign never\n\
         \x20 gpg --armor --export-secret-keys packages@echowire.org > echowire-repo-signing.key\n\
         \x20 gpg --armor --export packages@echowire.org > echowire.asc\n\n\
         Back up echowire-repo-signing.key offline and keep it out of this repository. Every \
         client pins the matching public key, so losing it means each installation has to be \
         repointed at a new key by hand."
    )
}

fn set_private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .with_context(|| format!("Failed to restrict permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

async fn run_publish(args: LinuxRepoPublishArgs) -> Result<()> {
    ensure!(
        args.root.is_dir(),
        "{} is not a directory. Run `linux-repo build` first",
        args.root.display()
    );
    let bucket = match args.bucket {
        Some(bucket) => bucket,
        None => require_any_env(&["S3_DOWNLOADS_BUCKET", "S3_BUCKET"])?,
    };

    let mut packages = Vec::new();
    let mut indexes = Vec::new();
    for tree in [APT_TREE_DIRECTORY, RPM_TREE_DIRECTORY] {
        let root = args.root.join(tree);
        if !root.is_dir() {
            continue;
        }
        verify_signed_tree(tree, &root)?;
        for file in collect_files(&root)? {
            let relative = file.strip_prefix(&root)?;
            let key = format!(
                "{tree}/{}",
                relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/")
            );
            let mut item = S3UploadPlanItem::new(file, key.clone())
                .with_cache_control(repo_cache_control_for_key(&key));
            if let Some(content_type) = repo_content_type_for_key(&key) {
                item = item.with_content_type(content_type);
            }
            if is_repo_package_key(&key) {
                packages.push(item);
            } else {
                indexes.push(item);
            }
        }
    }
    ensure!(
        !packages.is_empty(),
        "{} contains no packages to publish",
        args.root.display()
    );

    if args.dry_run {
        for item in packages.iter().chain(indexes.iter()) {
            println!(
                "s3://{bucket}/{} cache-control={}",
                item.key,
                item.cache_control.as_deref().unwrap_or("")
            );
        }
        println!(
            "Dry run: {} packages and {} index files would be uploaded",
            packages.len(),
            indexes.len()
        );
        return Ok(());
    }

    let client = s3_client(None).await?;
    // Packages first: an index that names a package the bucket does not hold yet makes every
    // client fail, while a package nothing references yet is inert.
    let package_stats = upload_s3_plan_append_only(&client, &bucket, packages).await?;
    let index_stats = upload_s3_plan_overwrite(&client, &bucket, indexes).await?;
    println!(
        "Published to s3://{bucket}: packages uploaded {}, packages already present {}, index \
         files written {}",
        package_stats.uploaded, package_stats.skipped_existing, index_stats.uploaded
    );
    Ok(())
}

fn verify_signed_tree(tree: &str, root: &Path) -> Result<()> {
    let files = collect_files(root)?;
    let signatures: Vec<&PathBuf> = files
        .iter()
        .filter(|file| {
            let name = file.file_name().unwrap_or_default().to_string_lossy();
            name == "InRelease" || name == "repomd.xml.asc"
        })
        .collect();
    ensure!(
        !signatures.is_empty(),
        "The {tree} tree at {} carries no signature (no InRelease or repomd.xml.asc). Rebuild it \
         with a signing key: an unsigned repository is refused by apt and dnf and must not be \
         published.",
        root.display()
    );
    ensure!(
        files.iter().any(|file| {
            file.file_name().unwrap_or_default().to_string_lossy() == PUBLIC_KEY_FILENAME
        }),
        "The {tree} tree at {} has no {PUBLIC_KEY_FILENAME}, so clients would have no key to \
         verify it with",
        root.display()
    );
    Ok(())
}

fn is_repo_package_key(key: &str) -> bool {
    key.ends_with(".deb") || key.ends_with(".rpm")
}

fn repo_cache_control_for_key(key: &str) -> &'static str {
    if is_repo_package_key(key) {
        PACKAGE_CACHE_CONTROL
    } else {
        INDEX_CACHE_CONTROL
    }
}

fn repo_content_type_for_key(key: &str) -> Option<&'static str> {
    let filename = key.rsplit('/').next().unwrap_or(key);
    if key.ends_with(".deb") {
        return Some("application/vnd.debian.binary-package");
    }
    if key.ends_with(".rpm") {
        return Some("application/x-rpm");
    }
    match filename {
        "Packages" | "Release" | "InRelease" | "Release.gpg" => {
            return Some("text/plain; charset=utf-8");
        }
        _ => {}
    }
    if filename.ends_with(".asc") || filename == RPM_REPO_FILENAME || filename == APT_SOURCES_FILENAME
    {
        return Some("text/plain; charset=utf-8");
    }
    s3_content_type_for_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(package: &str, version: &str) -> DebFields {
        DebFields {
            package: package.to_string(),
            version: version.to_string(),
            architecture: APT_ARCH.to_string(),
        }
    }

    #[test]
    fn pool_path_follows_the_debian_layout() {
        assert_eq!(
            pool_relative_path("stable", &fields("echowire", "2026.825.12857")),
            PathBuf::from("pool/stable/main/e/echowire/echowire_2026.825.12857_amd64.deb")
        );
        assert_eq!(
            pool_relative_path("canary", &fields("echowire-canary", "2026.823.233628")),
            PathBuf::from(
                "pool/canary/main/e/echowire-canary/echowire-canary_2026.823.233628_amd64.deb"
            )
        );
    }

    #[test]
    fn pool_path_uses_the_library_prefix_and_drops_the_epoch() {
        assert_eq!(
            pool_relative_path("stable", &fields("libechowire", "1:2.0")),
            PathBuf::from("pool/stable/main/libe/libechowire/libechowire_2.0_amd64.deb")
        );
    }

    #[test]
    fn release_overrides_describe_the_suite() {
        let overrides = apt_release_overrides("canary");
        assert!(overrides.contains(&"APT::FTPArchive::Release::Suite=canary".to_string()));
        assert!(overrides.contains(&"APT::FTPArchive::Release::Codename=canary".to_string()));
        assert!(overrides.contains(&"APT::FTPArchive::Release::Architectures=amd64".to_string()));
        assert!(overrides.contains(&"APT::FTPArchive::Release::Components=main".to_string()));
    }

    #[test]
    fn channels_must_be_safe_suite_names() {
        assert_eq!(
            validated_channels(&["stable".to_string(), "canary".to_string()]).unwrap(),
            vec!["stable".to_string(), "canary".to_string()]
        );
        for rejected in ["../etc", "Stable", "sta ble", "", "a/b"] {
            assert!(
                validated_channels(&[rejected.to_string()]).is_err(),
                "{rejected:?} should be rejected"
            );
        }
        assert!(validated_channels(&["stable".to_string(), "stable".to_string()]).is_err());
    }

    #[test]
    fn apt_sources_snippet_enables_only_stable() {
        let sources = apt_sources_file(
            "https://echowire.org/api/dl",
            &["stable".to_string(), "canary".to_string()],
        );
        assert!(sources.contains("URIs: https://echowire.org/api/dl/apt"));
        assert!(sources.contains("Suites: stable"));
        assert!(sources.contains("Suites: canary"));
        assert!(sources.contains(&format!("Signed-By: {KEYRING_INSTALL_PATH}")));
        assert_eq!(sources.matches("Enabled: yes").count(), 1);
        assert_eq!(sources.matches("Enabled: no").count(), 1);
    }

    #[test]
    fn rpm_repo_snippet_pins_the_key_and_disables_canary() {
        let repo = rpm_repo_file(
            "https://echowire.org/api/dl",
            &["stable".to_string(), "canary".to_string()],
        );
        assert!(repo.contains("[echowire]\n"));
        assert!(repo.contains("[echowire-canary]\n"));
        assert!(repo.contains("baseurl=https://echowire.org/api/dl/rpm/stable/x86_64"));
        assert!(repo.contains("gpgkey=https://echowire.org/api/dl/rpm/echowire.asc"));
        assert!(repo.contains("repo_gpgcheck=1"));
        assert_eq!(repo.matches("enabled=1").count(), 1);
        assert_eq!(repo.matches("enabled=0").count(), 1);
    }

    #[test]
    fn cache_control_keeps_indexes_fresh_and_packages_forever() {
        assert_eq!(
            repo_cache_control_for_key("apt/dists/stable/InRelease"),
            INDEX_CACHE_CONTROL
        );
        assert_eq!(
            repo_cache_control_for_key("rpm/stable/x86_64/repodata/repomd.xml"),
            INDEX_CACHE_CONTROL
        );
        assert_eq!(
            repo_cache_control_for_key("apt/pool/stable/main/e/echowire/echowire_1_amd64.deb"),
            PACKAGE_CACHE_CONTROL
        );
        assert_eq!(
            repo_cache_control_for_key("rpm/stable/x86_64/echowire-1.x86_64.rpm"),
            PACKAGE_CACHE_CONTROL
        );
    }

    #[test]
    fn content_types_cover_the_repository_files() {
        assert_eq!(
            repo_content_type_for_key("apt/pool/stable/main/e/echowire/echowire_1_amd64.deb"),
            Some("application/vnd.debian.binary-package")
        );
        assert_eq!(
            repo_content_type_for_key("rpm/stable/x86_64/echowire-1.x86_64.rpm"),
            Some("application/x-rpm")
        );
        assert_eq!(
            repo_content_type_for_key("apt/dists/stable/main/binary-amd64/Packages"),
            Some("text/plain; charset=utf-8")
        );
        assert_eq!(
            repo_content_type_for_key("apt/echowire.asc"),
            Some("text/plain; charset=utf-8")
        );
        assert_eq!(
            repo_content_type_for_key("rpm/echowire.repo"),
            Some("text/plain; charset=utf-8")
        );
    }

    #[test]
    fn missing_key_message_names_the_inputs_and_the_generation_command() {
        let message = missing_signing_key_message();
        assert!(message.contains(SIGNING_KEY_FILE_ENV));
        assert!(message.contains(SIGNING_KEY_ENV));
        assert!(message.contains(SIGNING_KEY_ID_ENV));
        assert!(message.contains("gpg --quick-generate-key"));
        assert!(message.contains("Back up"));
    }

    #[test]
    fn secret_key_fingerprints_are_read_from_the_colon_listing() {
        let listing = "sec:u:4096:1:AAAA:::::::::\nfpr:::::::::1111111111111111111111111111111111111111:\nuid:u::::::::echowire <packages@echowire.org>::::\nssb:u:4096:1:BBBB:::::::::\nfpr:::::::::2222222222222222222222222222222222222222:\n";
        assert_eq!(
            secret_key_fingerprints(listing),
            vec!["1111111111111111111111111111111111111111".to_string()]
        );
    }

    #[test]
    fn publish_refuses_a_tree_without_signatures() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(APT_TREE_DIRECTORY);
        let binary = root.join("dists/stable/main/binary-amd64");
        fs::create_dir_all(&binary).unwrap();
        fs::write(binary.join("Packages"), "Package: echowire\n").unwrap();
        fs::write(root.join("dists/stable/Release"), "Suite: stable\n").unwrap();
        fs::write(root.join(PUBLIC_KEY_FILENAME), "key").unwrap();
        let error = verify_signed_tree(APT_TREE_DIRECTORY, &root).unwrap_err();
        assert!(error.to_string().contains("no signature"));

        fs::write(root.join("dists/stable/InRelease"), "signed").unwrap();
        verify_signed_tree(APT_TREE_DIRECTORY, &root).unwrap();
    }

    #[test]
    fn publish_refuses_a_tree_without_a_public_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(APT_TREE_DIRECTORY);
        fs::create_dir_all(root.join("dists/stable")).unwrap();
        fs::write(root.join("dists/stable/InRelease"), "signed").unwrap();
        let error = verify_signed_tree(APT_TREE_DIRECTORY, &root).unwrap_err();
        assert!(error.to_string().contains(PUBLIC_KEY_FILENAME));
    }
}
