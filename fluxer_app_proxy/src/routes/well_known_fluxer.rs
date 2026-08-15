// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::discovery_cache::DiscoveryCache;
use crate::state::AppState;
use axum::{
    Json,
    extract::State,
    http::{HeaderValue, header},
    response::{IntoResponse, Redirect, Response},
};

/// Serve the instance discovery document at the domain root.
///
/// Echowire mounts the API under `/api`, so the canonical document only existed
/// at `/api/.well-known/fluxer` and the root path fell through to the SPA
/// catch-all, which answered instance probes with HTML. Clients only look under
/// `/api` for a hardcoded list of upstream hosts (see `buildWellKnownUrl` in
/// fluxer_app), so every other client — ours included — probed the root and
/// failed. Serving it here fixes already-shipped clients with no rebuild.
///
/// The cached body is the API's response verbatim, so this cannot drift from
/// `/api/.well-known/fluxer`. `Access-Control-Allow-Origin: *` mirrors the API
/// handler: discovery is meant to be fetched cross-origin by clients pointed at
/// another instance, which is the whole point of the endpoint.
pub async fn well_known_fluxer(State(state): State<AppState>) -> Response {
    render(&state.discovery_cache).await
}

async fn render(cache: &DiscoveryCache) -> Response {
    let Some(discovery) = cache.get().await else {
        // Cache not warm yet (initial fetch failed, still retrying in the
        // background). Send callers to the API rather than 5xx-ing a probe.
        return Redirect::temporary("/api/.well-known/fluxer").into_response();
    };

    let mut response = Json(discovery.data).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn serves_the_cached_discovery_document_with_open_cors() {
        let cache = DiscoveryCache::new();
        let document = serde_json::json!({
            "api_code_version": 1,
            "endpoints": {"api": "https://echowire.org/api"},
        });
        cache.set_for_tests(document.clone()).await;

        let response = render(&cache).await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "*"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(actual, document);
    }

    #[tokio::test]
    async fn redirects_to_the_api_when_the_cache_is_cold() {
        let cache = DiscoveryCache::new();

        let response = render(&cache).await;

        assert_eq!(
            response.status(),
            axum::http::StatusCode::TEMPORARY_REDIRECT
        );
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/api/.well-known/fluxer"
        );
    }
}
