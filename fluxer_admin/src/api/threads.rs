// SPDX-License-Identifier: AGPL-3.0-or-later

// Echowire: admin client for thread and forum post moderation.

use crate::api::generated::{snowflake, types as generated_types};

use super::client::{AdminApiClient, ApiResult};
use super::types::{ListChannelThreadsResponse, SuccessResponse, ThreadSummaryInfo};

impl AdminApiClient {
    pub async fn list_channel_threads(
        &self,
        channel_id: &str,
    ) -> ApiResult<Vec<ThreadSummaryInfo>> {
        let response = self
            .generated()
            .list_admin_channel_threads(&snowflake(channel_id))
            .await
            .map_err(|e| self.generated_error(e))?;
        let resp: ListChannelThreadsResponse = self.generated_value(response.into_inner())?;
        Ok(resp.threads)
    }

    pub async fn update_thread_state(
        &self,
        channel_id: &str,
        archived: Option<bool>,
        locked: Option<bool>,
    ) -> ApiResult<SuccessResponse> {
        let body = generated_types::UpdateAdminThreadRequest { archived, locked };
        let response = self
            .generated()
            .update_admin_channel_thread(&snowflake(channel_id), &body)
            .await
            .map_err(|e| self.generated_error(e))?;
        let _: serde_json::Value = self.generated_value(response.into_inner())?;
        Ok(SuccessResponse { success: true })
    }

    pub async fn delete_thread(&self, channel_id: &str) -> ApiResult<SuccessResponse> {
        let response = self
            .generated()
            .delete_admin_channel_thread(&snowflake(channel_id))
            .await
            .map_err(|e| self.generated_error(e))?;
        self.generated_value(response.into_inner())
    }
}
