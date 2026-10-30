// SPDX-License-Identifier: AGPL-3.0-or-later

package instance

func init() {
	codeRoots = append(codeRoots, "fluxer_marketing/src")
	codeServices["fluxer_marketing/"] = []string{}
	notEnvNames = append(notEnvNames, "GET", "DENY")
}

var forkNoFileVars = []string{
	"FLUXER_DISCOVERY_WEBHOOK_TAG", "FLUXER_DISCOVERY_WEBHOOK_TAG_ID", "FLUXER_DISCOVERY_WEBHOOK_URL",
	"FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG", "FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG_ID", "FLUXER_REGISTRATION_PENDING_WEBHOOK_URL",
	"FLUXER_REPORT_WEBHOOK_TAG", "FLUXER_REPORT_WEBHOOK_TAG_ID", "FLUXER_REPORT_WEBHOOK_URL",
}

var forkEnvHelp = map[string]string{
	"FLUXER_PASSKEY_RP_NAME":          "The title browsers show for echowire when someone creates or uses a passkey. When it's empty, browsers show `echowire`.",
	"FLUXER_APP_PRODUCT_NAME":         "The product name the apps show and echowire uses in emails and system messages. When it's empty, echowire uses `echowire`.",
	"FLUXER_AUTH_BLUESKY_ENABLED":     "Whether people can link a Bluesky account to their profile. Use `true` or `false`. It needs FLUXER_AUTH_BLUESKY_KEYS. When it's empty, echowire uses `true`.",
	"FLUXER_AUTH_BLUESKY_CLIENT_NAME": "The app name Bluesky shows when someone links their account. When it's empty, Bluesky shows `echowire`, even when FLUXER_APP_PRODUCT_NAME is set.",
}

var forkEnvVars = []envVar{
	{"FLUXER_API_ADDITIONAL_CORS_ORIGINS", envInternalSection, "A comma separated list of extra origins the api allows in CORS responses."},
	{"FLUXER_API_DESKTOP_GITHUB_REDIRECT_COUNTRIES", envInternalSection, "A comma separated list of country codes whose desktop downloads redirect to GitHub releases."},
	{"FLUXER_API_PRESIGNED_DOWNLOADS_ENABLED", envInternalSection, "Whether the api hands out presigned URLs for downloads from the separate downloads bucket. Use `true` or `false`."},
	{"FLUXER_CAPTCHA_ENABLED", envInternalSection, "Whether sign-up and sign-in ask for a captcha. Use `true` or `false`. It needs FLUXER_CAPTCHA_PROVIDER."},
	{"FLUXER_CAPTCHA_PROVIDER", envInternalSection, "Which captcha provider the api checks tokens with. Use `altcha`, `hcaptcha` or `turnstile`. `none` is not accepted while FLUXER_CAPTCHA_ENABLED is `true`."},
	{"FLUXER_CAPTCHA_HCAPTCHA_SITE_KEY", envInternalSection, "The hCaptcha site key. Use it with FLUXER_CAPTCHA_PROVIDER set to `hcaptcha`."},
	{"FLUXER_CAPTCHA_HCAPTCHA_SECRET_KEY", envInternalSection, "The hCaptcha secret key. Use it with FLUXER_CAPTCHA_PROVIDER set to `hcaptcha`."},
	{"FLUXER_CAPTCHA_TURNSTILE_SITE_KEY", envInternalSection, "The Cloudflare Turnstile site key. Use it with FLUXER_CAPTCHA_PROVIDER set to `turnstile`."},
	{"FLUXER_CAPTCHA_TURNSTILE_SECRET_KEY", envInternalSection, "The Cloudflare Turnstile secret key. Use it with FLUXER_CAPTCHA_PROVIDER set to `turnstile`."},
	{"FLUXER_REGISTRATION_PENDING_WEBHOOK_URL", envInternalSection, "The webhook URL that gets a card for each registration waiting for approval. It can point at a forum or a text channel."},
	{"FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG", envInternalSection, "The forum tag, by name, that the registration card gets. When it's empty, the tag is `new`."},
	{"FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG_ID", envInternalSection, "The forum tag, by ID, that the registration card gets. It takes the place of FLUXER_REGISTRATION_PENDING_WEBHOOK_TAG."},
	{"FLUXER_REPORT_WEBHOOK_URL", envInternalSection, "The webhook URL that gets a card for each report. It can point at a forum or a text channel."},
	{"FLUXER_REPORT_WEBHOOK_TAG", envInternalSection, "The forum tag, by name, that the report card gets. When it's empty, the tag is `new`."},
	{"FLUXER_REPORT_WEBHOOK_TAG_ID", envInternalSection, "The forum tag, by ID, that the report card gets. It takes the place of FLUXER_REPORT_WEBHOOK_TAG."},
	{"FLUXER_DISCOVERY_WEBHOOK_URL", envInternalSection, "The webhook URL that gets a card for each community discovery application. It can point at a forum or a text channel."},
	{"FLUXER_DISCOVERY_WEBHOOK_TAG", envInternalSection, "The forum tag, by name, that the discovery application card gets. When it's empty, the tag is `new`."},
	{"FLUXER_DISCOVERY_WEBHOOK_TAG_ID", envInternalSection, "The forum tag, by ID, that the discovery application card gets. It takes the place of FLUXER_DISCOVERY_WEBHOOK_TAG."},
	{"FLUXER_GATEWAY_PUSH_UNREAD_CAP", envInternalSection, "The most pushes one person gets for one channel before they read it. Use a number."},
	{"FLUXER_GATEWAY_PUSH_UNREAD_CAP_TTL_SECONDS", envInternalSection, "How many seconds the unread push count for a channel lasts before it resets. Use a number."},
	{"FLUXER_S3_BUCKET_DOWNLOADS", envInternalSection, "The name of the separate bucket that holds desktop and mobile downloads."},
	{"FLUXER_S3_DOWNLOADS_ENDPOINT", envInternalSection, "The S3 endpoint of the downloads bucket."},
	{"FLUXER_S3_DOWNLOADS_PUBLIC_ENDPOINT", envInternalSection, "The public base URL that presigned download links use."},
	{"FLUXER_S3_DOWNLOADS_REGION", envInternalSection, "The region of the downloads bucket."},
	{"FLUXER_S3_DOWNLOADS_FORCE_PATH_STYLE", envInternalSection, "Whether the downloads bucket uses path-style URLs. Use `true` or `false`."},
	{"FLUXER_S3_DOWNLOADS_ACCESS_KEY_ID", envInternalSection, "The access key ID for the downloads bucket."},
	{"FLUXER_S3_DOWNLOADS_SECRET_ACCESS_KEY", envInternalSection, "The secret access key for the downloads bucket."},
	{"FLUXER_MARKETING_HOST", envInternalSection, "The address the marketing site listens on. The image sets `0.0.0.0`."},
	{"FLUXER_MARKETING_PORT", envInternalSection, "The port the marketing site listens on. The image sets `8080`."},
	{"FLUXER_MARKETING_SECRET_KEY_BASE", envInternalSection, "The secret key the marketing site signs with. It must be set in production."},
	{"FLUXER_MARKETING_BASE_PATH", envInternalSection, "The path the marketing site is served under. Leave it empty to serve it from the root."},
	{"FLUXER_MARKETING_LINUX_REPO_ENABLED", envInternalSection, "Whether the marketing site shows the Linux package repository instructions. Use `true` or `false`."},
	{"FLUXER_RELEASE_CHANNEL", envInternalSection, "The release channel the marketing download page shows, `stable` or `canary`. The marketing site also reads RELEASE_CHANNEL."},
	{"FLUXER_CLIENT_IP_HEADER", envInternalSection, "The same as FLUXER_CLIENT_IP_HEADER_NAME. The marketing site accepts both."},
	{"CLIENT_IP_HEADER_NAME", envInternalSection, "The same as FLUXER_CLIENT_IP_HEADER_NAME. The marketing site accepts it without the prefix."},
	{"CLIENT_IP_HEADER", envInternalSection, "The same as FLUXER_CLIENT_IP_HEADER_NAME. The marketing site accepts it without the prefix."},
	{"MAXMIND_DB_PATH", envInternalSection, "The same as FLUXER_GEOIP_DB_PATH. The marketing site accepts it as a second name."},
}

func withForkEnvVars(upstream []envVar) []envVar {
	out := make([]envVar, 0, len(upstream)+len(forkEnvVars))
	for _, v := range upstream {
		if help, ok := forkEnvHelp[v.name]; ok {
			v.help = help
		}
		out = append(out, v)
	}
	return append(out, forkEnvVars...)
}
