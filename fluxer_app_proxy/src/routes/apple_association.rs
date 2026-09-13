// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    Json,
    http::header,
    response::{IntoResponse, Response},
};
use serde_json::json;

pub async fn apple_app_site_association() -> Response {
    let paths = json!([
        "/channels/*",
        "/invite/*",
        "/gift/*",
        "/users/*",
        "/settings/user/*",
        "/reset/*",
        "/notifications/*",
        "/you/*"
    ]);
    let body = json!({
        "applinks": {
            "apps": [],
            "details": [
                {"appID": "34589PFK6A.org.echowire.ios", "paths": paths},
                {"appID": "34589PFK6A.org.echowire.ios.canary", "paths": paths}
            ]
        },
        "webcredentials": {
            "apps": [
                "34589PFK6A.org.echowire.ios",
                "34589PFK6A.org.echowire.ios.canary"
            ]
        }
    });

    (
        [(header::CACHE_CONTROL, "public, max-age=1800")],
        Json(body),
    )
        .into_response()
}
