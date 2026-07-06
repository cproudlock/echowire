// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json,
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

pub async fn assetlinks() -> Response {
    let body = json!([
        {
            "relation": [
                "delegate_permission/common.handle_all_urls",
                "delegate_permission/common.get_login_creds"
            ],
            "target": {
                "namespace": "android_app",
                "package_name": "org.echowire.twa",
                "sha256_cert_fingerprints": [
                    "02:9C:A2:1A:C9:A6:96:C3:F9:8B:FC:84:3F:9D:3D:63:89:29:5F:5B:4F:91:B3:D5:67:AC:AA:4D:B9:41:7E:7E",
                    "2F:7A:6D:CA:0D:B4:B7:4D:6F:66:BA:AB:4A:D9:5C:8E:1D:05:C3:C2:BD:DF:BC:17:A6:38:CF:0B:49:BE:04:B1"
                ]
            }
        }
    ]);

    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=1800"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn assetlinks_serves_android_login_credentials_association() {
        let response = assetlinks().await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=1800"
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            actual,
            serde_json::json!([
                {
                    "relation": [
                        "delegate_permission/common.handle_all_urls",
                        "delegate_permission/common.get_login_creds"
                    ],
                    "target": {
                        "namespace": "android_app",
                        "package_name": "org.echowire.twa",
                        "sha256_cert_fingerprints": [
                            "02:9C:A2:1A:C9:A6:96:C3:F9:8B:FC:84:3F:9D:3D:63:89:29:5F:5B:4F:91:B3:D5:67:AC:AA:4D:B9:41:7E:7E",
                            "2F:7A:6D:CA:0D:B4:B7:4D:6F:66:BA:AB:4A:D9:5C:8E:1D:05:C3:C2:BD:DF:BC:17:A6:38:CF:0B:49:BE:04:B1"
                        ]
                    }
                }
            ])
        );
    }
}
