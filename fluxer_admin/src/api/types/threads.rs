// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: admin views of a thread or forum post.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThreadSummaryInfo {
    pub id: String,
    pub guild_id: String,
    pub parent_id: Option<String>,
    pub parent_name: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub thread_type: i32,
    pub owner_id: Option<String>,
    pub archived: bool,
    pub locked: bool,
    pub pinned: bool,
    pub message_count: Option<i64>,
    pub member_count: Option<i64>,
    pub auto_archive_duration: Option<i64>,
    pub archive_timestamp: Option<String>,
    pub create_timestamp: Option<String>,
    pub applied_tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ListChannelThreadsResponse {
    #[serde(default)]
    pub threads: Vec<ThreadSummaryInfo>,
}
