// SPDX-License-Identifier: AGPL-3.0-or-later

crate::marketing_message!(
    pub const DOWNLOAD_DOWNLOAD_DESCRIPTOR = {
        key: "download.download",
        message: "Download",
        comment: "Button or link label on the download page, download buttons, or install calls to action. Keep platform-download wording short, direct, and action-oriented; preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_DOWNLOAD_APP_OR_OPEN_IN_BROWSER_DESCRIPTOR = {
        key: "download.download_app_or_open_in_browser",
        message: "Download the app or open {product_name} in your browser to start connecting with your communities.",
        comment: "Final call-to-action body copy on the download page. Preserve {product_name} exactly; make clear that users can either install the app or use the browser version. Preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_DOWNLOAD_FLUXER_DESCRIPTOR = {
        key: "download.download_fluxer",
        message: "Download {product_name}",
        comment: "Button or link label on the download page, download buttons, or install calls to action. Keep platform-download wording short, direct, and action-oriented; preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_DOWNLOAD_FOR_PLATFORM_DESCRIPTOR = {
        key: "download.download_for_platform",
        message: "Download for {platform}",
        comment: "Button or link label on the download page, download buttons, or install calls to action. Keep platform-download wording short, direct, and action-oriented; preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_OTHER_DOWNLOADS_DESCRIPTOR = {
        key: "download.other_downloads",
        message: "Other downloads",
        comment: "Inline label that precedes a short row of alternate desktop download links (other architecture, package formats, build variants) on the download page. Keep it short.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_OPEN_IN_BROWSER_DESCRIPTOR = {
        key: "download.open_in_browser",
        message: "Open in browser",
        comment: "Button or link label on the download page, download buttons, or install calls to action. Keep platform-download wording short, direct, and action-oriented; preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_SCREENSHOTS_COURTESY_OF_DESCRIPTOR = {
        key: "download.screenshots_courtesy_of",
        message: "Screenshots courtesy of ",
        comment: "Button or link label on the download page, download buttons, or install calls to action. Keep platform-download wording short, direct, and action-oriented; preserve placeholders exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_LINUX_REPO_HEADING_DESCRIPTOR = {
        key: "download.linux_repo_heading",
        message: "Install from the package repository",
        comment: "Heading of the section on the download page that explains adding the Linux apt or rpm package repository instead of downloading a single file. Keep it short.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_LINUX_REPO_BODY_DESCRIPTOR = {
        key: "download.linux_repo_body",
        message: "Add the repository once and {product_name} updates alongside the rest of your system. Both repositories are signed, and these commands trust our key for {product_name} only.",
        comment: "Body copy under the Linux package repository heading on the download page. Preserve the {product_name} placeholder exactly.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_LINUX_REPO_DEBIAN_HEADING_DESCRIPTOR = {
        key: "download.linux_repo_debian_heading",
        message: "Debian, Ubuntu and derivatives",
        comment: "Label above the shell commands that add the apt package repository on the download page. It names the distribution families the commands apply to; leave the distribution names untranslated.",
    };
);

crate::marketing_message!(
    pub const DOWNLOAD_LINUX_REPO_RPM_HEADING_DESCRIPTOR = {
        key: "download.linux_repo_rpm_heading",
        message: "Fedora, RHEL and openSUSE",
        comment: "Label above the shell commands that add the rpm package repository on the download page. It names the distribution families the commands apply to; leave the distribution names untranslated.",
    };
);
