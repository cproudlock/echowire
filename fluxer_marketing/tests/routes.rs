// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use fluxer_marketing::{
    build_router,
    config::{MarketingConfig, ReleaseChannel},
};
use http_body_util::BodyExt;
use std::collections::{BTreeMap, BTreeSet};
use tower::ServiceExt;

fn test_config() -> MarketingConfig {
    let mut config = MarketingConfig::from_env();
    config.env = fluxer_marketing::config::RuntimeEnv::Test;
    config.host = "127.0.0.1".to_owned();
    config.port = 0;
    config.secret_key_base = "test-secret".to_owned();
    config.marketing_endpoint = "https://fluxer.test".to_owned();
    config.base_path.clear();
    config.api_endpoint = "https://api.fluxer.test".to_owned();
    config.build_version = "test".to_owned();
    config.geoip_db_path.clear();
    config.trust_client_ip_header = false;
    config.client_ip_header_name = "x-real-ip".to_owned();
    config
}

#[tokio::test]
async fn canary_responses_send_robots_header_on_all_surfaces() {
    let mut config = test_config();
    config.release_channel = ReleaseChannel::Canary;
    let app = build_router(config);
    let expected = "noindex, nofollow, nosnippet, noimageindex, notranslate, max-snippet:0, max-image-preview:none, max-video-preview:0";

    for request in [
        Request::builder().uri("/").body(Body::empty()).unwrap(),
        Request::builder()
            .uri("/static/htmx.min.js")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/")
            .header(header::HOST, "fluxer.gg")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/missing")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.headers().get("x-robots-tag").unwrap(), expected);
    }
}

#[tokio::test]
async fn stable_responses_do_not_send_canary_robots_header() {
    let app = build_router(test_config());
    let response = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert!(!response.headers().contains_key("x-robots-tag"));
}

#[tokio::test]
async fn assetlinks_serves_android_login_credentials_association() {
    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/assetlinks.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=1800"
    );

    let body = response.into_body().collect().await.unwrap().to_bytes();
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

#[tokio::test]
async fn responses_send_security_headers_on_all_surfaces() {
    let app = build_router(test_config());
    for request in [
        Request::builder().uri("/").body(Body::empty()).unwrap(),
        Request::builder()
            .uri("/static/htmx.min.js")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/")
            .header(header::HOST, "fluxer.gg")
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/missing")
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response
                .headers()
                .get(header::STRICT_TRANSPORT_SECURITY)
                .unwrap(),
            "max-age=31536000; includeSubDomains; preload"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY).unwrap(),
            "strict-origin-when-cross-origin"
        );
        assert_eq!(
            response.headers().get(header::X_FRAME_OPTIONS).unwrap(),
            "DENY"
        );
        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("script-src 'self' 'sha256-"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
        assert!(response.headers().contains_key("permissions-policy"));
    }
}

#[tokio::test]
async fn document_titles_use_marketing_title_patterns() {
    let app = build_router(test_config());

    let home = render_path(app.clone(), "/").await;
    assert_document_title(&home, "echowire - A chat app that puts you first");

    let download = render_path(app.clone(), "/download").await;
    assert_document_title(&download, "Download echowire | echowire");

    let response = app
        .oneshot(
            Request::builder()
                .uri("/missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let not_found = String::from_utf8(body.to_vec()).unwrap();
    assert_document_title(&not_found, "Page not found | echowire");
    assert!(!not_found.contains("echowire | Page not found"));
}

#[tokio::test]
async fn home_uses_accept_language_catalog() {
    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::ACCEPT_LANGUAGE, "fr-FR,fr;q=0.9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains("lang=\"fr\""));
    assert!(html.contains("Une appli de chat"));
    assert!(html.contains("/marketing/flags/1f1f8-1f1ea.svg"));
    assert!(!html.contains("/marketing/flags/se.svg"));
}

// Removed `blog_post_under_base_path_prefixes_embedded_asset_urls`: it rendered the
// `mobile-clients-and-fluxer-v2` blog post to verify base-path prefixing of embedded
// assets, but all blog posts (and their assets) were intentionally dropped in the
// echowire fork, so there is no remaining content to exercise this contract.

#[tokio::test]
async fn accept_language_prefers_exact_supported_locale_before_fallback() {
    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::ACCEPT_LANGUAGE, "fr-CA,de;q=0.9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains("lang=\"de\""), "{html}");
}

#[tokio::test]
async fn locale_route_sets_signed_cookie_and_redirects() {
    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_locale")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from("locale=de&redirect=%2Fdownload"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/download"
    );
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.starts_with("locale="));
    let value = set_cookie
        .strip_prefix("locale=")
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let payload = value.split('.').next().unwrap();
    let bytes = URL_SAFE_NO_PAD.decode(payload).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json.get("locale").unwrap(), "de");
    assert!(
        json.get("createdAt")
            .and_then(|value| value.as_u64())
            .is_some()
    );
}

#[tokio::test]
async fn sitemap_contains_content_routes() {
    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/sitemap.xml")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let xml = String::from_utf8(body.to_vec()).unwrap();
    assert!(xml.contains("https://fluxer.test/privacy"));
    assert!(xml.contains("https://fluxer.test/help/report-bug"));
    assert!(xml.contains("https://fluxer.test/blog"));
    // Per-post `/blog/<slug>` and per-job `/careers/<slug>` sitemap entries were dropped
    // along with the blog posts and job postings deleted in the echowire fork.
}

#[tokio::test]
async fn help_center_serves_imported_articles_and_legacy_redirects() {
    let app = build_router(test_config());

    let help = render_path(app.clone(), "/help").await;
    assert!(help.contains("Help center"));
    // The "March 2026 Plutonium promotion" help article was intentionally deleted in the
    // echowire fork, so it no longer appears in the help center listing.
    assert!(help.contains("How to delete or disable your account"));
    assert!(help.contains("Legal &amp; Policy"));
    assert!(!help.contains("https://help.fluxer.app"));

    let search = render_path(app.clone(), "/help?q=regional").await;
    assert!(search.contains("Search results"));
    assert!(search.contains("Regional restrictions"));

    let article = render_path(app.clone(), "/help/report-bug").await;
    assert!(article.contains("Bug report template"));
    assert!(article.contains("heading-anchor-link"));
    assert!(article.contains("article:modified_time\" content=\"2026-03-07\""));
    assert!(!article.contains("https://help.fluxer.app"));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/help/13984986-reporting-a-bug")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/help/report-bug"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/en/articles/13984933-minimum-age-requirements")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/help/minimum-age"
    );

    let response = app
        .oneshot(
            Request::builder()
                .uri("/en/collections/18821560-account")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/help#account"
    );
}

#[tokio::test]
async fn help_host_only_redirects_to_canonical_marketing_help_routes() {
    let app = build_router(test_config());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "help.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/help"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/en/articles/13984933-minimum-age-requirements")
                .header(header::HOST, "help.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/help/minimum-age"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/help/13984986-reporting-a-bug")
                .header(header::HOST, "help.echowire.org:443")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/help/report-bug"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/en/collections/18821560-account")
                .header(header::HOST, "help.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/help#account"
    );

    let response = app
        .oneshot(
            Request::builder()
                .uri("/download")
                .header(header::HOST, "help.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/help"
    );
}

#[tokio::test]
async fn old_origin_marketing_redirects_are_preserved() {
    let app = build_router(test_config());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/docs?ref=old")
                .header(header::HOST, "www.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/docs?ref=old"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "fluxer.gg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://echowire.org/invite/"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/guild")
                .header(header::HOST, "fluxer.gg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://echowire.org/invite/guild"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/spring")
                .header(header::HOST, "fluxer.gift")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://echowire.org/gift/spring"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/install")
                .header(header::HOST, "fluxer.dev")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://docs.echowire.org/install"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "every.day.im.fluxer.ing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://www.youtube.com/watch?v=KQ6zr6kCPj8"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/channels/@me?source=old")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://echowire.org/channels/@me?source=old"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/delete-my-account")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/help/delete-account"
    );

    let response = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/fluxer")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://api.fluxer.test/.well-known/fluxer"
    );
}

#[tokio::test]
async fn app_redirects_and_cta_links_share_the_canary_web_app_origin_on_every_channel() {
    const CANARY_WEB_APP_ORIGIN: &str = "https://echowire.org";

    for channel in [ReleaseChannel::Stable, ReleaseChannel::Canary] {
        let mut config = test_config();
        config.release_channel = channel;
        let app = build_router(config);

        for (host, uri, expected) in [
            ("fluxer.gg", "/", format!("{CANARY_WEB_APP_ORIGIN}/invite/")),
            (
                "fluxer.gg",
                "/guild",
                format!("{CANARY_WEB_APP_ORIGIN}/invite/guild"),
            ),
            (
                "fluxer.gift",
                "/spring",
                format!("{CANARY_WEB_APP_ORIGIN}/gift/spring"),
            ),
            (
                "fluxer.app",
                "/channels/@me?source=old",
                format!("{CANARY_WEB_APP_ORIGIN}/channels/@me?source=old"),
            ),
            (
                "fluxer.app",
                "/channels",
                format!("{CANARY_WEB_APP_ORIGIN}/channels"),
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(header::HOST, host)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
            assert_eq!(
                response.headers().get(header::LOCATION).unwrap(),
                expected.as_str()
            );
        }

        let html = render_path(app, "/").await;
        assert!(html.contains(&format!("{CANARY_WEB_APP_ORIGIN}/channels/@me")));
        assert!(!html.contains("https://app.fluxer."));
    }
}

#[tokio::test]
async fn blog_serves_imported_posts_feeds_assets_and_legacy_redirects() {
    let app = build_router(test_config());

    // All blog posts (and their embedded assets) were intentionally deleted in the
    // echowire fork, so the index renders empty. The blog index, feeds, and legacy
    // redirect routes still exist and are exercised below; per-post rendering, post
    // search/tag results, and blog asset serving have been removed because there is no
    // remaining content to exercise them.
    let blog = render_path(app.clone(), "/blog").await;
    assert!(blog.contains("echowire Blog"));
    assert!(blog.contains("href=\"/blog/rss.xml\""));
    assert!(blog.contains("href=\"/blog/atom.xml\""));
    assert!(!blog.contains("https://blog.fluxer.app/rss/"));
    assert!(!blog.contains("min read"));

    let search = render_path(app.clone(), "/blog?q=federation").await;
    assert!(search.contains("Search results"));

    let tag = render_path(app.clone(), "/blog?tag=news").await;
    assert!(tag.contains("Filtered by News"));

    let rss = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/blog/rss.xml")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rss.status(), StatusCode::OK);
    assert_eq!(
        rss.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/rss+xml; charset=utf-8"
    );
    let body = rss.into_body().collect().await.unwrap().to_bytes();
    let rss_xml = String::from_utf8(body.to_vec()).unwrap();
    assert!(rss_xml.contains("<title>echowire Blog</title>"));

    let atom = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/blog/atom.xml")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(atom.status(), StatusCode::OK);
    assert_eq!(
        atom.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/atom+xml; charset=utf-8"
    );
    let body = atom.into_body().collect().await.unwrap().to_bytes();
    let atom_xml = String::from_utf8(body.to_vec()).unwrap();
    assert!(atom_xml.contains("<feed xmlns=\"http://www.w3.org/2005/Atom\">"));

    let response = app
        .clone()
        .oneshot(Request::builder().uri("/rss").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/blog/rss.xml"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/blog/tag/news")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/blog?tag=news"
    );
}

#[tokio::test]
async fn blog_host_only_redirects_to_canonical_marketing_blog_routes() {
    let app = build_router(test_config());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header(header::HOST, "blog.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/blog"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/roadmap-2026/")
                .header(header::HOST, "blog.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // The `roadmap-2026` post was deleted in the echowire fork, so a legacy per-post
    // blog-host URL now gracefully degrades to the blog index instead of the post.
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/blog"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/rss/")
                .header(header::HOST, "blog.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/blog/rss.xml"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/tag/news/")
                .header(header::HOST, "blog.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/blog?tag=news"
    );

    let response = app
        .oneshot(
            Request::builder()
                .uri("/content/images/2026/04/cover.png")
                .header(header::HOST, "blog.echowire.org")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "https://fluxer.test/blog/assets/how-i-built-fluxer-cover-1280.jpg"
    );
}

#[tokio::test]
async fn download_page_renders_strips_and_cache_header() {
    let mut config = test_config();
    config.api_endpoint = "http://127.0.0.1:9".to_owned();
    config.release_channel = ReleaseChannel::Stable;
    let expected_download_url = format!(
        "/dl/desktop/{}/win32/x64/latest/setup?test=1",
        ReleaseChannel::Stable.segment()
    );
    // Echowire builds win32/x64 only; the Windows alternate is the game-capture build.
    let expected_game_capture_url = format!(
        "/dl/desktop/{}/win32/x64/windows-game-capture/latest/setup?test=1",
        ReleaseChannel::Stable.segment()
    );
    let app = build_router(config);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/download?test=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=60, stale-while-revalidate=300"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(!html.contains("download-overlay"));
    assert!(!html.contains("download-button-group"));
    assert!(!html.contains("popovertarget=\"dl-"));
    assert!(!html.contains("download-card-grid"));
    assert!(!html.contains("/dl/desktop/source/latest"));
    assert!(html.contains(&expected_download_url));
    assert!(html.contains(&expected_game_capture_url));
    let channel = ReleaseChannel::Stable.segment();
    assert!(html.contains(&format!("/dl/desktop/{channel}/linux/x64/latest/appimage?test=1")));
    // Echowire: no macOS build, no arm64 Linux build, no Flatpak published -> none linked.
    assert!(!html.contains("darwin"));
    assert!(!html.contains("flathub"));
    assert!(!html.contains(&format!("/dl/desktop/{channel}/linux/arm64/")));
}

#[tokio::test]
async fn download_page_uses_channel_api_endpoint_fallback_when_configured_endpoint_is_empty() {
    let mut config = test_config();
    config.api_endpoint.clear();
    config.release_channel = ReleaseChannel::Canary;
    let app = build_router(config);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/download?test=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains(
        "https://api.canary.echowire.org/dl/desktop/canary/linux/x64/latest/appimage?test=1"
    ));
}

#[tokio::test]
async fn donation_page_renders_business_tab_and_swish_proxy_rejects_bad_amount() {
    let app = build_router(test_config());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/donate?type=business")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains("id=\"donate-content-business\" class=\"donate-content w-full\""));
    assert!(html.contains("/_donations/checkout"));
    assert!(html.contains("hx-post=\"/_donations/checkout\""));
    assert!(html.contains("hx-target=\"#donation-error-business\""));
    assert!(html.contains("<script src=\"/static/htmx.min.js?v=test\" defer>"));
    assert!(!html.contains("unpkg.com/htmx.org"));
    assert!(html.contains("hx-select=\"#donation-interaction\""));
    assert!(html.contains("hx-target=\"#donation-interaction\""));
    assert!(html.contains("hx-push-url=\"true\""));
    assert!(html.contains("id=\"donation-amount-fieldset-business\""));
    assert!(html.contains("hx-get=\"/_donations/amounts?audience=business&amp;currency=eur\""));
    assert!(html.contains("hx-target=\"#donation-amount-fieldset-business\""));
    assert!(html.contains("hx-get=\"/_swish/payment\""));
    assert!(html.contains("hx-target=\"#swish-payment-fragment\""));
    assert!(html.contains("hx-swap=\"outerHTML\""));
    assert!(html.contains("/_donations/request-link"));
    assert!(html.contains("hx-post=\"/_donations/request-link\""));
    assert!(html.contains("hx-target=\"#manage-message\""));
    assert!(html.contains("/_swish/qr"));
    assert!(!html.contains("name=\"swish\" value=\"1\""));
    assert!(html.contains("id=\"swish-donate-link\""));
    assert!(html.contains("href=\"#swish-modal-backdrop\""));
    assert!(html.contains("href=\"#_\""));
    assert!(html.contains("swish-grad-1"));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_donations/checkout")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(
                    "audience=individual&email=invalid&amount_major=25&interval=once&currency=usd",
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/donate?type=individual&error=invalid_email"
    );

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_donations/checkout")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header("HX-Request", "true")
                .body(Body::from(
                    "audience=individual&email=invalid&amount_major=25&interval=once&currency=usd",
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::LOCATION));
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let fragment = String::from_utf8(body.to_vec()).unwrap();
    assert!(fragment.contains("id=\"donation-error-individual\""));
    assert!(fragment.contains("role=\"alert\""));
    assert!(fragment.contains("Please enter a valid email address"));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_donations/request-link")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header("HX-Request", "true")
                .body(Body::from("email=invalid"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::LOCATION));
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let fragment = String::from_utf8(body.to_vec()).unwrap();
    assert!(fragment.contains("id=\"manage-message\""));
    assert!(fragment.contains("role=\"alert\""));
    assert!(fragment.contains("Please enter a valid email address"));

    let checkout_api = axum::Router::new().route(
        "/donations/checkout",
        axum::routing::post(|| async {
            axum::Json(serde_json::json!({
                "url": "https://checkout.fluxer.test/session"
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, checkout_api).await.unwrap();
    });
    let mut config = test_config();
    config.api_endpoint = api_endpoint;
    let checkout_app = build_router(config);
    let response = checkout_app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/_donations/checkout")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .header("HX-Request", "true")
                .body(Body::from(
                    "audience=individual&email=test%40example.com&amount_major=25&interval=once&currency=usd",
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    server.abort();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("hx-redirect").unwrap(),
        "https://checkout.fluxer.test/session"
    );

    let response = app
        .oneshot(
            Request::builder()
                .uri("/_swish/qr?amount=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let app = build_router(test_config());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/static/htmx.min.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/javascript; charset=utf-8"
    );

    let app = build_router(test_config());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/_donations/amounts?audience=individual&currency=inr")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let fragment = String::from_utf8(body.to_vec()).unwrap();
    assert!(fragment.contains("id=\"donation-amount-fieldset-individual\""));
    assert!(fragment.contains("value=\"1000\" checked"));
    assert!(fragment.contains("min=\"500\" max=\"100000\""));
    assert!(fragment.contains("Minimum donation:"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/_donations/amounts?audience=individual&currency=btc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn product_program_and_press_pages_are_not_placeholders() {
    let app = build_router(test_config());
    for (path, expected) in [
        ("/reverb", "Free vs Reverb"),
        ("/partners", "Partner perks"),
        ("/press", "logo-color.svg"),
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let html = String::from_utf8(body.to_vec()).unwrap();
        assert!(html.contains(expected), "{path} did not contain {expected}");
    }

    let plutonium = render_path(app, "/reverb").await;
    for expected in [
        "<table",
        "--fluxer-premium-inner: #4641D9;",
        "Most popular",
        "Custom 4-digit username tag",
        "Message character limit",
        "Emoji and sticker packs",
        "Saved media",
        "Video quality",
        "Animated avatars and banners",
        "Custom themes",
        "25 MB",
        "500 MB",
        "Free self-hosting",
        "Operator Pass",
        "One-time purchase",
        "Everything in Free, plus:",
    ] {
        assert!(
            plutonium.contains(expected),
            "/reverb did not contain {expected}"
        );
    }
}

#[tokio::test]
async fn rendered_pages_keep_no_js_and_accessibility_contracts() {
    let mut config = test_config();
    config.api_endpoint = "http://127.0.0.1:9".to_owned();
    let app = build_router(config);
    let paths = [
        "/",
        "/download?test=1",
        "/donate?type=business",
        "/donate?type=individual&error=invalid_amount&currency=usd",
        "/donate?swish=1&swish_amount=75",
        "/donate/manage?alert=sent&email=test%40example.com",
        "/privacy",
        "/help",
        "/help/report-bug",
        "/blog",
        // `/blog/<slug>` dropped: all blog posts were deleted in the echowire fork.
        "/careers",
        "/partners",
        "/press",
        "/reverb",
        "/does-not-exist",
    ];

    for path in paths {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(
            [StatusCode::OK, StatusCode::NOT_FOUND].contains(&response.status()),
            "{path} returned {}",
            response.status()
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let html = String::from_utf8(body.to_vec()).unwrap();
        if path == "/privacy" || path.starts_with("/help/") {
            assert_policy_client_js(path, &html);
        } else if path.starts_with("/blog/") {
            assert_blog_article_client_js(path, &html);
        } else if path.starts_with("/donate/manage") {
            assert_donation_manage_htmx_contract(path, &html);
        } else if path.starts_with("/donate?") {
            assert_donation_htmx_contract(path, &html);
        } else {
            assert_no_client_js(path, &html);
        }
        if path == "/" {
            assert_voice_region_map_tappable_contract(&html);
        }
        assert_no_duplicate_ids(path, &html);
        assert_aria_references_exist(path, &html);
        assert_all_images_have_alt(path, &html);
        assert_blank_targets_are_safe(path, &html);
        assert!(
            html.contains(
                "role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"locale-modal-title\""
            ),
            "{path} is missing the locale dialog accessibility contract"
        );
    }

    let download = render_path(app.clone(), "/download?test=1").await;
    assert!(
        download
            .contains("role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"pwa-modal-title\"")
    );
    assert!(download.contains("<fieldset class=\"contents\">"));
    assert!(download.contains("aria-controls=\"pwa-panel-android\""));
    assert!(download.contains("aria-controls=\"pwa-panel-ios\""));
    assert!(download.contains("aria-controls=\"pwa-panel-desktop\""));

    let donation_error = render_path(
        app.clone(),
        "/donate?type=individual&error=invalid_amount&currency=usd",
    )
    .await;
    assert!(donation_error.matches("<fieldset").count() >= 3);
    assert!(donation_error.matches("<legend").count() >= 3);
    assert!(donation_error.contains("role=\"alert\""));
    assert!(donation_error.contains("aria-live=\"polite\""));
    assert!(donation_error.contains("aria-current=\"page\""));

    let swish_modal = render_path(app.clone(), "/donate?swish=1&swish_amount=75").await;
    assert!(!swish_modal.contains("pwa-modal-backdrop-open"));
    assert!(swish_modal.contains("href=\"#swish-modal-backdrop\""));
    assert!(swish_modal.contains("href=\"#_\""));
    assert!(swish_modal.contains("M208.49,191.51"));
    assert!(swish_modal.contains("id=\"swish-grad-1-donate-link\""));
    assert!(swish_modal.contains("/_swish/qr?amount=75"));

    let mobile_swish_modal = app
        .oneshot(
            Request::builder()
                .uri("/donate?swish_amount=75")
                .header(
                    header::USER_AGENT,
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = mobile_swish_modal
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let mobile_html = String::from_utf8(body.to_vec()).unwrap();
    assert!(mobile_html.contains("Open Swish"));
    assert!(mobile_html.contains("swish://payment?data="));
    assert!(!mobile_html.contains("/_swish/qr?amount=75"));
}

async fn render_path(app: axum::Router, path: &str) -> String {
    let response = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(body.to_vec()).unwrap()
}

fn assert_document_title(html: &str, expected: &str) {
    assert!(
        html.contains(&format!("<title>{expected}</title>")),
        "document title {expected:?} was not rendered"
    );
    assert!(
        html.contains(&format!("property=\"og:title\" content=\"{expected}\"")),
        "OpenGraph title {expected:?} was not rendered"
    );
    assert!(
        html.contains(&format!("name=\"twitter:title\" content=\"{expected}\"")),
        "Twitter title {expected:?} was not rendered"
    );
}

fn assert_no_client_js(path: &str, html: &str) {
    for needle in [
        "<script",
        "hx-",
        "javascript:",
        " onclick=",
        " onchange=",
        " oninput=",
        " onmouseover=",
        " onsubmit=",
    ] {
        assert!(
            !html.contains(needle),
            "{path} contains client-side JS marker {needle:?}"
        );
    }
}

fn assert_voice_region_map_tappable_contract(html: &str) {
    assert!(html.contains("<div class=\"voice-region-pin absolute h-6 w-6 rounded-full\""));
    assert!(
        html.contains("<button id=\"voice-region-pin-sea\" type=\"button\" class=\"voice-region-pin-target\" aria-label=\"Seattle (SEA)\" aria-describedby=\"voice-region-pin-sea-tooltip\">")
    );
    assert!(html.contains("id=\"voice-region-pin-sea-tooltip\" role=\"tooltip\""));
    assert!(html.contains("class=\"voice-region-tooltip-label font-semibold text-sm\""));
    assert!(html.contains("class=\"voice-region-pin-dot block h-full w-full"));
    assert_eq!(
        html.matches("rel=\"preload\" as=\"image\" href=\"/static/voice-region-flags/")
            .count(),
        12
    );
    assert!(html.contains(
        "rel=\"preload\" as=\"image\" href=\"/static/voice-region-flags/1f1fa-1f1f8.svg\""
    ));
    assert!(html.contains("src=\"/static/voice-region-flags/1f1fa-1f1f8.svg\" alt=\"\" aria-hidden=\"true\" loading=\"eager\" decoding=\"async\""));
    assert!(!html.contains("<details class=\"voice-region-pin"));
    assert!(!html.contains("src=\"/static/voice-region-flags/1f1fa-1f1f8.svg\" alt=\"\" aria-hidden=\"true\" loading=\"lazy\""));
}

fn assert_donation_htmx_contract(path: &str, html: &str) {
    for needle in [
        "<script src=\"/static/htmx.min.js?v=test\"",
        "hx-post=\"/_donations/checkout\"",
        "hx-target=\"#donation-error-individual\"",
        "hx-select=\"#donation-interaction\"",
        "hx-target=\"#donation-interaction\"",
        "hx-push-url=\"true\"",
        "id=\"donation-amount-fieldset-individual\"",
        "hx-get=\"/_donations/amounts?audience=individual&amp;currency=eur\"",
        "hx-trigger=\"change\"",
        "hx-target=\"#donation-amount-fieldset-individual\"",
        "hx-params=\"none\"",
        "hx-get=\"/_swish/payment\"",
        "hx-target=\"#swish-payment-fragment\"",
        "hx-swap=\"outerHTML\"",
        "hx-push-url=\"false\"",
        "hx-post=\"/_donations/request-link\"",
        "hx-target=\"#manage-message\"",
    ] {
        assert!(
            html.contains(needle),
            "{path} is missing donation HTMX contract {needle:?}"
        );
    }
    for forbidden in [
        "javascript:",
        " onclick=",
        " onchange=",
        " oninput=",
        " onmouseover=",
        " onsubmit=",
    ] {
        assert!(
            !html.contains(forbidden),
            "{path} contains unsafe JS marker {forbidden:?}"
        );
    }
}

fn assert_donation_manage_htmx_contract(path: &str, html: &str) {
    for needle in [
        "<script src=\"/static/htmx.min.js?v=test\"",
        "hx-post=\"/_donations/request-link\"",
        "hx-target=\"#manage-message\"",
        "hx-swap=\"outerHTML\"",
        "hx-push-url=\"false\"",
    ] {
        assert!(
            html.contains(needle),
            "{path} is missing manage HTMX contract {needle:?}"
        );
    }
    for forbidden in [
        "javascript:",
        " onclick=",
        " onchange=",
        " oninput=",
        " onmouseover=",
        " onsubmit=",
    ] {
        assert!(
            !html.contains(forbidden),
            "{path} contains unsafe JS marker {forbidden:?}"
        );
    }
}

fn assert_blog_article_client_js(path: &str, html: &str) {
    for needle in [
        "<script",
        "heading-anchor-link",
        "data-anchor-link=",
        "navigator.clipboard.writeText",
    ] {
        assert!(
            html.contains(needle),
            "{path} is missing blog markdown script contract {needle:?}"
        );
    }
    assert!(
        !html.contains("id=\"policy-toc\""),
        "{path} should not render a table of contents"
    );
    for forbidden in [
        "javascript:",
        " onclick=",
        " onchange=",
        " oninput=",
        " onmouseover=",
        " onsubmit=",
    ] {
        assert!(
            !html.contains(forbidden),
            "{path} contains unsafe JS marker {forbidden:?}"
        );
    }
}

fn assert_policy_client_js(path: &str, html: &str) {
    for needle in [
        "<script",
        "id=\"policy-toc\" class=\"hidden lg:block\"",
        "heading-anchor-link",
        "data-anchor-link=",
        "navigator.clipboard.writeText",
    ] {
        assert!(
            html.contains(needle),
            "{path} is missing policy markdown script contract {needle:?}"
        );
    }
    for forbidden in [
        "javascript:",
        " onclick=",
        " onchange=",
        " oninput=",
        " onmouseover=",
        " onsubmit=",
    ] {
        assert!(
            !html.contains(forbidden),
            "{path} contains unsafe JS marker {forbidden:?}"
        );
    }
}

fn assert_no_duplicate_ids(path: &str, html: &str) {
    let mut counts = BTreeMap::<String, usize>::new();
    for id in attribute_values(html, "id") {
        *counts.entry(id).or_default() += 1;
    }
    let duplicates = counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .collect::<Vec<_>>();
    assert!(
        duplicates.is_empty(),
        "{path} has duplicate ids: {duplicates:?}"
    );
}

fn assert_aria_references_exist(path: &str, html: &str) {
    let ids = attribute_values(html, "id")
        .into_iter()
        .collect::<BTreeSet<_>>();
    for attr in ["aria-controls", "aria-describedby", "aria-labelledby"] {
        for value in attribute_values(html, attr) {
            for id in value.split_whitespace() {
                assert!(
                    ids.contains(id),
                    "{path} has {attr} reference to missing id {id:?}"
                );
            }
        }
    }
}

fn assert_all_images_have_alt(path: &str, html: &str) {
    let mut rest = html;
    while let Some(offset) = rest.find("<img") {
        let after_start = &rest[offset..];
        let Some(end) = after_start.find('>') else {
            panic!("{path} has an unterminated img tag");
        };
        let tag = &after_start[..end];
        assert!(tag.contains(" alt=\""), "{path} has img without alt: {tag}");
        rest = &after_start[end + 1..];
    }
}

fn assert_blank_targets_are_safe(path: &str, html: &str) {
    let mut rest = html;
    while let Some(offset) = rest.find("<a ") {
        let after_start = &rest[offset..];
        let Some(end) = after_start.find('>') else {
            panic!("{path} has an unterminated anchor tag");
        };
        let tag = &after_start[..end];
        if tag.contains("target=\"_blank\"") {
            assert!(
                tag.contains("rel=\"noopener noreferrer\""),
                "{path} has target=_blank without noopener noreferrer: {tag}"
            );
        }
        rest = &after_start[end + 1..];
    }
}

fn attribute_values(html: &str, name: &str) -> Vec<String> {
    let needle = format!("{name}=\"");
    let mut values = Vec::new();
    let mut rest = html;
    while let Some(offset) = rest.find(&needle) {
        let value_start = offset + needle.len();
        let after_start = &rest[value_start..];
        let Some(value_end) = after_start.find('"') else {
            break;
        };
        values.push(after_start[..value_end].to_owned());
        rest = &after_start[value_end + 1..];
    }
    values
}
