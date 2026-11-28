// SPDX-License-Identifier: AGPL-3.0-or-later

package instance

// Echowire: settings only this fork reads. Kept in their own file so upstream's
// envvars.go merges cleanly. The echowire stack sets them through
// deploy/self-hosting/docker-compose.yml, not rexctl, so they sit in "internal".
func init() {
	envVars = append(envVars,
		envVar{"FLUXER_API_ADDITIONAL_CORS_ORIGINS", "internal", "Extra origins the API allows for cross-origin requests, comma separated, such as the canary web app."},
		envVar{"FLUXER_API_DESKTOP_GITHUB_REDIRECT_COUNTRIES", "internal", "Countries, as ISO codes, whose desktop download requests are redirected to the GitHub release instead of the downloads bucket."},
		envVar{"FLUXER_API_PRESIGNED_DOWNLOADS_ENABLED", "internal", "Whether desktop downloads redirect to presigned URLs on the downloads bucket."},
		envVar{"FLUXER_CAPTCHA_ENABLED", "internal", "Whether sign-up and sign-in ask for a captcha."},
		envVar{"FLUXER_CAPTCHA_PROVIDER", "internal", "The default captcha provider: none, altcha, hcaptcha or turnstile. The admin panel setting overrides it."},
		envVar{"FLUXER_CAPTCHA_HCAPTCHA_SITE_KEY", "internal", "The hCaptcha site key."},
		envVar{"FLUXER_CAPTCHA_HCAPTCHA_SECRET_KEY", "internal", "The hCaptcha secret key."},
		envVar{"FLUXER_CAPTCHA_TURNSTILE_SITE_KEY", "internal", "The Cloudflare Turnstile site key."},
		envVar{"FLUXER_CAPTCHA_TURNSTILE_SECRET_KEY", "internal", "The Cloudflare Turnstile secret key."},
		envVar{"FLUXER_DISCOVERY_WEBHOOK_URL", "internal", "A webhook that receives a forum thread for each new discovery application."},
		envVar{"FLUXER_DISCOVERY_WEBHOOK_TAG", "internal", "The forum tag name the discovery webhook applies."},
		envVar{"FLUXER_DISCOVERY_WEBHOOK_TAG_ID", "internal", "The forum tag id the discovery webhook applies."},
		envVar{"FLUXER_REGISTRATION_PENDING_WEBHOOK_URL", "internal", "A webhook that receives a forum thread for each registration waiting for approval."},
		envVar{"FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG", "internal", "The forum tag name the registration webhook applies."},
		envVar{"FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG_ID", "internal", "The forum tag id the registration webhook applies."},
		envVar{"FLUXER_REPORT_WEBHOOK_URL", "internal", "A webhook that receives a forum thread for each new report."},
		envVar{"FLUXER_REPORT_WEBHOOK_TAG", "internal", "The forum tag name the report webhook applies."},
		envVar{"FLUXER_REPORT_WEBHOOK_TAG_ID", "internal", "The forum tag id the report webhook applies."},
		envVar{"FLUXER_GATEWAY_PUSH_UNREAD_CAP", "internal", "How many pushes one user gets per channel before reading it. Defaults to 3."},
		envVar{"FLUXER_GATEWAY_PUSH_UNREAD_CAP_TTL_SECONDS", "internal", "How long the unread push count is kept, in seconds. Defaults to 86400."},
		envVar{"FLUXER_S3_BUCKET_DOWNLOADS", "internal", "The bucket desktop downloads and updates are served from."},
		envVar{"FLUXER_S3_DOWNLOADS_ENDPOINT", "internal", "The object store address for the downloads bucket."},
		envVar{"FLUXER_S3_DOWNLOADS_PUBLIC_ENDPOINT", "internal", "The public address of the downloads bucket."},
		envVar{"FLUXER_S3_DOWNLOADS_REGION", "internal", "The region of the downloads bucket."},
		envVar{"FLUXER_S3_DOWNLOADS_ACCESS_KEY_ID", "internal", "The access key for the downloads bucket."},
		envVar{"FLUXER_S3_DOWNLOADS_SECRET_ACCESS_KEY", "internal", "The secret key for the downloads bucket."},
		envVar{"FLUXER_S3_DOWNLOADS_FORCE_PATH_STYLE", "internal", "Whether the downloads bucket uses path-style URLs."},
	)
}
