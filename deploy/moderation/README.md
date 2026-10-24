# echowire moderation sidecar

An NSFW image classifier and a ClamAV daemon, run on their own VM and used by the
app stack through settings that upstream already ships. Nothing here changes the
app code.

| Piece | What it does | App setting that points at it |
| --- | --- | --- |
| `nsfw-service` | Scores images and sampled video frames. The media proxy blocks uploads it rates explicit in channels that are not age-gated. | `FLUXER_NSFW_SERVICE_ENDPOINT`, `FLUXER_MEDIA_PROXY_NSFW_THRESHOLD` |
| `clamav` | Scans every attachment for malware. | `FLUXER_CLAMAV_ENABLED`, `_HOST`, `_PORT`, `_FAIL_OPEN` |

## What this does and does not catch

- It blocks explicit images and video in channels that are not marked 18+. In 18+
  channels and in adult DMs, explicit content is allowed by the Community
  Guidelines (section 4.6), so the classifier lets it through there.
- A classifier cannot tell consensual from non-consensual images. It therefore
  does **not** stop revenge porn posted in an 18+ space or a DM. That needs
  hash-matching against victim-submitted hashes (StopNCII), which is a separate
  piece of work and needs partner approval.
- It does not detect CSAM. Report and removal duties for that are unchanged.
- Expect false positives (swimwear, medical images, art). Start at the default
  threshold, review what gets blocked, and adjust.

## Failure behaviour: uploads stop if this VM is down

The media proxy treats any classifier error as "scan unavailable" and rejects the
upload. With `FLUXER_CLAMAV_FAIL_OPEN` unset or false, a ClamAV failure rejects
the upload too. That is deliberate for a safety control, so:

- monitor both ports and alert when either stops answering;
- to switch the checks off in an emergency, unset the settings below on the app
  VM and run `docker compose up -d` there. That restores uploads without scanning.

## VM

- Debian or Ubuntu, 4 vCPU, 8 GB RAM, 40 GB disk, Docker with the compose plugin.
- Give it a fixed LAN address, `MODERATION_BIND_IP`.
- Allow TCP 8080 and 3310 from the app VM only (ufw or the Proxmox firewall).
  Neither service authenticates callers, because the media proxy cannot send
  credentials, so the network rule is the access control.

## Install

```sh
cd deploy/moderation
echo "MODERATION_BIND_IP=<lan ip of this vm>" > .env
docker compose up -d --build
docker compose ps
curl -s http://$MODERATION_BIND_IP:8080/healthz
```

The first ClamAV start downloads its signature database and can take a few
minutes before it reports healthy.

## Wire up the app VM

In `/root/selfhost/.env` on the app VM:

```
FLUXER_NSFW_SERVICE_ENDPOINT=http://<moderation vm ip>:8080
FLUXER_MEDIA_PROXY_NSFW_THRESHOLD=0.85
FLUXER_CLAMAV_ENABLED=true
FLUXER_CLAMAV_HOST=<moderation vm ip>
FLUXER_CLAMAV_PORT=3310
FLUXER_CLAMAV_FAIL_OPEN=false
```

then `docker compose up -d` so the `api` and `media-proxy` containers pick them up.
Test with one clearly safe image (must upload) and, with the VM stopped, confirm
that an upload is refused rather than silently unscanned.

## Tests

The service has unit tests that use a fake classifier, plus one test that loads
the real model. Run them in the built image:

```sh
docker build -t echowire/nsfw-service:local nsfw-service
docker run --rm --user 0 -e NSFW_REAL_MODEL=1 -v "$PWD/nsfw-service/tests:/app/tests:ro" \
  --entrypoint sh echowire/nsfw-service:local \
  -c "pip install -q pytest httpx && cd /app && python -m pytest -q tests"
```

## Model

`Marqo/nsfw-image-detection-384`, Apache-2.0, baked into the image at build time
so a running container never needs the internet. Set `NSFW_MODEL_ID` to swap it
for another timm model whose labels include `NSFW`.
