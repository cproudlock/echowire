//! Brand guard for the marketing site.
//!
//! echowire is a fork of Fluxer. Upstream's marketing copy describes upstream programmes and
//! perks that echowire does not offer (the Partner / Verified / Discovery programmes, free
//! Plutonium, "Fluxer staff"). This test fails when the words Fluxer, Plutonium or Neko show up
//! in the visible marketing copy, so upstream text cannot come back silently through an upstream
//! merge.
//!
//! Two sources are scanned:
//!   1. every `content/**/*.md` file (help articles, policies, jobs),
//!   2. the `message:` strings of the descriptors in `src/i18n/descriptors/*.rs`. The `comment:`
//!      fields are translator notes and legitimately name upstream, so they are not scanned.
//!
//! A mention that is on purpose goes in the allow lists below, with the reason next to it. Do not
//! allow-list upstream programme text: delete it instead.

use std::fs;
use std::path::{Path, PathBuf};

const BANNED_WORDS: &[&str] = &["fluxer", "plutonium", "neko"];

/// Markdown files (relative to the crate root) that name an upstream brand on purpose.
const ALLOWED_CONTENT_FILES: &[(&str, &str)] = &[
    (
        "content/help/articles/echowire-vs-discord.md",
        "the comparison article names Fluxer deliberately: its table compares Discord, Fluxer and self-hosted Fluxer",
    ),
    (
        "content/policies/changelog.md",
        "names the fluxerusercontent.com CDN domain, which is a real infrastructure hostname",
    ),
    (
        "content/policies/company-information.md",
        "the source-code line states that echowire is a fork of upstream fluxerapp/fluxer",
    ),
    (
        "content/policies/privacy.md",
        "names the fluxerusercontent.com CDN domain and the Fluxerbot User-Agent, both real technical identifiers site operators need",
    ),
    (
        "content/policies/security.md",
        "the security scope lists the real fluxer.* domains that the service operates",
    ),
];

/// Descriptor keys (the `key:` of a `marketing_message!`) whose `message:` names an upstream
/// brand on purpose.
const ALLOWED_DESCRIPTOR_KEYS: &[(&str, &str)] = &[
    (
        "content.help.article.echowire_vs_discord.description",
        "summary of the comparison article, which names Fluxer deliberately",
    ),
    (
        "footer.upstream_fluxer",
        "the footer and menu link to fluxer.app, the upstream project echowire is built on, labelled as upstream",
    ),
];

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn files_with_extension(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            files_with_extension(&path, extension, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some(extension) {
            out.push(path);
        }
    }
}

fn banned_words_in(text: &str) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    BANNED_WORDS
        .iter()
        .copied()
        .filter(|word| lower.contains(word))
        .collect()
}

fn relative(path: &Path) -> String {
    path.strip_prefix(crate_root())
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/")
}

/// Reads the Rust string literal that starts at `text[start..]` (just after the opening quote)
/// and returns the unescaped-enough content plus the index after the closing quote.
fn read_string_literal(text: &str, start: usize) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let mut index = start;
    let mut value = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                // Keep the escaped character as is; the banned words never contain escapes.
                let next = text[index + 1..].chars().next()?;
                value.push(next);
                index += 1 + next.len_utf8();
            }
            b'"' => return Some((value, index + 1)),
            _ => {
                let ch = text[index..].chars().next().unwrap();
                value.push(ch);
                index += ch.len_utf8();
            }
        }
    }
    None
}

/// Returns `(key, message)` for every `key: "..."` followed by `message: "..."` in a descriptor
/// source file.
fn descriptor_messages(source: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut current_key = String::new();
    let mut offset = 0;
    while offset < source.len() {
        let rest = &source[offset..];
        let key_at = rest.find("key:");
        let message_at = rest.find("message:");
        let (at, is_key) = match (key_at, message_at) {
            (Some(k), Some(m)) if k < m => (k, true),
            (Some(k), None) => (k, true),
            (_, Some(m)) => (m, false),
            (None, None) => break,
        };
        let after_label = at
            + if is_key {
                "key:".len()
            } else {
                "message:".len()
            };
        let tail = &rest[after_label..];
        let trimmed = tail.trim_start();
        let quote_at = after_label + (tail.len() - trimmed.len());
        if trimmed.starts_with('"')
            && let Some((literal, end)) = read_string_literal(rest, quote_at + 1)
        {
            if is_key {
                current_key = literal;
            } else {
                found.push((current_key.clone(), literal));
            }
            offset += end;
            continue;
        }
        offset += after_label;
    }
    found
}

#[test]
fn content_markdown_does_not_name_upstream_brands() {
    let root = crate_root();
    let mut files = Vec::new();
    files_with_extension(&root.join("content"), "md", &mut files);
    assert!(!files.is_empty(), "no markdown content found");

    let mut leaks = Vec::new();
    for path in files {
        let rel = relative(&path);
        if ALLOWED_CONTENT_FILES
            .iter()
            .any(|(allowed, _)| *allowed == rel)
        {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let words = banned_words_in(&text);
        if !words.is_empty() {
            leaks.push(format!("{rel}: {}", words.join(", ")));
        }
    }
    assert!(
        leaks.is_empty(),
        "upstream brand words in marketing content (remove the text, or allow-list it with a reason in tests/brand_guard.rs):\n{}",
        leaks.join("\n")
    );
}

#[test]
fn descriptor_messages_do_not_name_upstream_brands() {
    let root = crate_root();
    let mut files = Vec::new();
    files_with_extension(&root.join("src/i18n/descriptors"), "rs", &mut files);
    assert!(!files.is_empty(), "no descriptor sources found");

    let mut scanned = 0;
    let mut declared = 0;
    let mut leaks = Vec::new();
    for path in files {
        let rel = relative(&path);
        let source = fs::read_to_string(&path).unwrap();
        declared += source.matches("message:").count();
        for (key, message) in descriptor_messages(&source) {
            scanned += 1;
            if ALLOWED_DESCRIPTOR_KEYS
                .iter()
                .any(|(allowed, _)| *allowed == key)
            {
                continue;
            }
            let words = banned_words_in(&message);
            if !words.is_empty() {
                leaks.push(format!("{rel}: {key}: {}", words.join(", ")));
            }
        }
    }
    assert_eq!(
        scanned, declared,
        "the descriptor parser missed some message: strings"
    );
    assert!(
        scanned > 300,
        "descriptor parser found only {scanned} messages"
    );
    assert!(
        leaks.is_empty(),
        "upstream brand words in descriptor messages (change the message, or allow-list the key with a reason in tests/brand_guard.rs):\n{}",
        leaks.join("\n")
    );
}

#[test]
fn allow_lists_point_at_real_entries() {
    let root = crate_root();
    for (file, reason) in ALLOWED_CONTENT_FILES {
        assert!(!reason.is_empty());
        let text = fs::read_to_string(root.join(file)).unwrap_or_else(|_| {
            panic!("allow-listed file {file} no longer exists; drop the entry")
        });
        assert!(
            !banned_words_in(&text).is_empty(),
            "allow-listed file {file} no longer names an upstream brand; drop the entry"
        );
    }
    let mut files = Vec::new();
    files_with_extension(&root.join("src/i18n/descriptors"), "rs", &mut files);
    let keys: Vec<String> = files
        .iter()
        .flat_map(|path| descriptor_messages(&fs::read_to_string(path).unwrap()))
        .map(|(key, _)| key)
        .collect();
    for (key, reason) in ALLOWED_DESCRIPTOR_KEYS {
        assert!(!reason.is_empty());
        assert!(
            keys.iter().any(|candidate| candidate == key),
            "allow-listed descriptor key {key} no longer exists; drop the entry"
        );
    }
}
