# IG Story Stalker

A self-hosted Instagram Story watcher that reuses a manually authenticated Chromium profile, checks one account for new Stories, delivers available photos and videos to Telegram, and archives Stories, posts, and Highlights to disk.

The project is designed for unattended Docker deployments. It includes a fail-closed network guard, persistent delivery state, health checks, a supervising worker, and an independent watchdog.

> [!WARNING]
> This is an unofficial tool built on Instagram's private web APIs. Those APIs and document IDs can change without notice. Use it only for accounts and content you are authorized to access, comply with applicable terms and laws, and do not treat the read-receipt guard as a guarantee of anonymity.
>
> **Do not use your primary or personal Instagram account.** Use a dedicated secondary account whose loss, lockout, or challenge would not affect your main account. Its authenticated browser profile is stored locally under `data/profile/`.

## Features

- Manual Instagram login through a temporary noVNC container
- Persistent Chromium session stored outside the image
- Headless Story checks with configurable intervals and exponential backoff
- Direct Telegram delivery for supported Story photos and videos
- Deduplication and durable retry state across restarts
- A network guard that blocks Story seen/read mutations and unexpected Instagram write requests
- Supervisor and watchdog health monitoring with queued Telegram alerts
- JSON audit logs that avoid recording signed media URLs

## Media downloads

The watcher archives Stories and scans profile posts and Highlights by default.
Docker mounts `IG_DOWNLOAD_DIR` (default: `./downloads`) at `/downloads` inside
`ig-watch`. No Synology-specific paths or additional Compose overlays are needed.
An existing `.env` also uses these defaults without adding new variables.

```text
downloads/
  stories/20261016_013000_JST_123456.mp4
  posts/00001_20261016_013000_JST/
    01.jpg
    02.mp4
    caption.txt
  highlight/01_旅行/
    001_20261016_013000_JST.jpg
```

Filenames use publication time in JST, with detection time as the Story fallback.
Images retain their actual `.jpg`, `.png`, or `.webp` format. Post carousels retain
all available photos and videos. Numbering is assigned on first discovery and
persists across restarts; existing folders retain their original Highlight title.
Caption edits update `caption.txt` without resending media. Deleted Instagram
content stays on disk, and downloaded files have no automatic expiry.

The first post/Highlight scan downloads accessible history without Telegram media
notifications. Later discoveries are downloaded and sent individually to Telegram.
Story archiving is independent of Telegram delivery, so currently available Stories
can be archived even if already sent. Expired or deleted Stories cannot be recovered
unless their media remains accessible. The dedicated Reels tab is not scanned.

Stories use `IG_CHECK_INTERVAL_SECONDS` (default 300). Post scans and Highlight
scans use `IG_POSTS_INTERVAL_SECONDS` and `IG_HIGHLIGHTS_INTERVAL_SECONDS` (default
900, range 300–86400). Pagination and Highlight reads run sequentially using the
same Chromium profile; a large scan can take several watcher cycles. Each archive
queue attempts at most five media downloads per cycle with a 90-second download
budget. Slow Telegram requests can extend the total cycle.

Set `IG_CATALOG_ENABLED=0` to disable posts and Highlights while retaining Story
archiving. Set `IG_DOWNLOAD_DIR` to another host directory if desired. After changing
settings, recreate the watcher with `./igctl up -d --force-recreate ig-watch`.

Archive and Telegram state are tracked independently under `data/watch/` (or
`IG_DATA_DIR/watch/`): `archive-<target>.json`, `catalog-<target>.json`, and their
`.required` markers protect download history and stable numbering. Do not delete
these to retry a download. Downloaded files and credentials are excluded from Git
and Docker build contexts; keep state and download backups private.

Downloads validate the CDN host, redirects, size and file signature, then rename
`.part` files atomically. Failures remain queued and trigger supervisor/watchdog
alerts with recovery notifications. Story downloads retire after seven days with
an unresolved alert; catalog downloads remain pending. Saved files are not periodically
revalidated, and manually deleted successful files are not automatically restored.
Telegram retries can produce duplicate messages if an acknowledgement is lost.

Check `WATCH_MEDIA_STARTED` for `archiveEnabled:true` and `catalogEnabled:true`,
`STORY_ARCHIVE_SAVED` / `CATALOG_MEDIA_SAVED` for saved files, and `CATALOG_STATUS`
for baseline completion and pending work. `STORY_MEDIA_SENT` alone does not mean
a file was archived. Verify downloaded files on the host as well.

Posts and Highlights use private read-only GraphQL queries with an exact request
allowlist; the Story guard remains unchanged. `IG_POSTS_DOC_ID` and
`IG_POSTS_PAGE_DOC_ID` can override post query IDs. Instagram API changes, session
expiry, rate limits, and unsupported response pagination are reported as errors
rather than an empty or complete scan. The test suite uses controlled fixtures;
it does not verify live Instagram compatibility.

## Requirements

- Docker Engine with Docker Compose v2
- A Telegram bot token and destination chat ID
- The target account's Instagram username
- Network access to Instagram and the Telegram Bot API

No host-level Node.js installation is required for normal use. Node.js 22 or newer is only needed for local syntax checks.

## Quick start

### 1. Configure the watcher

```sh
cp .env.example .env
cp .env.telegram.example .env.telegram
chmod 600 .env .env.telegram
```

Edit both files:

- `IG_TARGET_USERNAME` identifies the account to monitor (username only, without `@`).
- `IG_TARGET_USER_ID` is optional. Leave it unset to resolve the numeric ID automatically using your authenticated session. Existing values override lookup.
- `IG_CHECK_INTERVAL_SECONDS` must be between 60 and 86400.
- `VNC_PASSWORD` must be unique and at least 8 characters.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` control delivery.

Automatic lookup runs once at worker startup and again after a worker restart. It uses
the saved Instagram session, updates only the running process environment, and keeps
history keyed by numeric ID. It does not write to `.env`. Lookup failures (including
rate limits, expired sessions, or an unexpected account response) stop startup and
are retried by the supervisor. `TARGET_RESOLVED` records a successful lookup.
The Telegram-only test does not require an Instagram lookup.

The default noVNC binding is `127.0.0.1:6080`. Keep it local whenever possible.

### 2. Create the Instagram session

Use a dedicated secondary Instagram account for this session. Do not log in with your primary or personal account.

Build and start the temporary login container:

```sh
docker compose --profile login build ig-login
docker compose --profile login run --rm --service-ports ig-login
```

Open the following page and enter the VNC password from `.env`:

```text
http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale
```

Log in to Instagram, then stop the container with `Ctrl-C`. Wait for
`LOGIN_BROWSER_STOPPED` before running another browser command. Chromium closes
cleanly and the session is retained in `data/profile/`.

For a remote host, prefer an SSH tunnel instead of exposing noVNC:

```sh
ssh -L 6080:127.0.0.1:6080 user@your-server
```

### 3. Verify the session and safety guard

```sh
docker compose build ig-check
docker compose run --rm ig-check
docker compose run --rm ig-check node /app/src/guard-selftest.mjs
```

A valid session emits `SESSION_OK`. The guard test should emit `GUARD_SELFTEST_PASS`.

### 4. Test Telegram delivery

```sh
./igctl build ig-watch ig-watchdog
./igctl run --rm ig-watch node /app/src/watch-media.mjs --test-telegram
```

The test sends a text message only. It does not fetch or deliver a Story.

### 5. Start continuous monitoring

```sh
./igctl up -d ig-watch ig-watchdog
./igctl ps
./igctl logs -f ig-watch ig-watchdog
```

Stop all monitoring services with:

```sh
./igctl down
```

`igctl` combines `docker-compose.yml`, `compose.watch.yml`, and `compose.health.yml`. The resulting deployment runs the media watcher under a supervisor and keeps the independent watchdog in a separate container.

## Configuration

| Variable | File | Required | Description |
| --- | --- | --- | --- |
| `IG_TARGET_USERNAME` | `.env` | Yes, unless ID is supplied | Account username; used to resolve the numeric ID and in messages |
| `IG_TARGET_USER_ID` | `.env` | No | Optional numeric ID override; resolved automatically when omitted |
| `IG_CHECK_INTERVAL_SECONDS` | `.env` | No | Base polling interval; defaults to `300` |
| `VNC_PASSWORD` | `.env` | For login | Password for the temporary noVNC session |
| `NOVNC_BIND_ADDRESS` | `.env` | No | Host address for noVNC; defaults to `127.0.0.1` |
| `NOVNC_PORT` | `.env` | No | Host port for noVNC; defaults to `6080` |
| `IG_DATA_DIR` | `.env` | No | Host runtime-data directory; defaults to `./data` |
| `IG_LOG_DIR` | `.env` | No | Host log directory; defaults to `./logs` |
| `TELEGRAM_BOT_TOKEN` | `.env.telegram` | Yes | Telegram bot token |
| `TELEGRAM_CHAT_ID` | `.env.telegram` | Yes | Telegram destination chat ID |

## Useful commands

Run one Story fetch without Telegram delivery:

```sh
docker compose run --rm ig-check node /app/src/fetch-story.mjs
```

Run one complete media check and delivery cycle:

```sh
./igctl run --rm ig-watch node /app/src/watch-media.mjs --once
```

Queue a watchdog-path test alert while the stack is running:

```sh
./igctl exec ig-watchdog node /app/src/watchdog.mjs --self-test
```

Run the local JavaScript syntax check:

```sh
npm ci
npm test
```

## Runtime data

The following paths contain private or machine-specific data and are excluded from Git and Docker build contexts:

- `data/profile/` — Instagram cookies, local storage, history, and browser databases
- `data/watch/` — delivery history, pending media, health, and supervisor state
- `data/watchdog/` — watchdog issues, alert outbox, and delivery state
- `logs/` — local JSON audit and GUI service logs
- `.env` and `.env.telegram` — local configuration and credentials

Back up `data/` privately if delivery history and session persistence matter to you. Never publish it or attach it to a GitHub issue.

## How it works

```text
Instagram session profile
          |
          v
  watch-supervisor
          |
          v
    watch-media  -----> Telegram photos/videos
          |
          +-----> durable state + health files
                         |
                         v
                      watchdog -----> Telegram alerts
```

The browser worker bootstraps an authenticated Instagram page and performs one allow-listed Story GraphQL query for the configured numeric account ID. The network guard blocks known seen/read operations and rejects other Instagram write requests. Story media URLs are passed through a private temporary file, delivered to Telegram, and never written to the audit log.

## Troubleshooting

### `SESSION_INVALID`

Run the temporary login container again. Instagram may have expired the session or requested a checkpoint.

### `BOOTSTRAP_TOKEN_ERROR` or GraphQL/schema errors

Instagram likely changed its page data, private GraphQL request, or response schema. Review the logs before retrying; repeated automated retries can make account challenges more likely.

### Telegram test fails

Confirm that the bot token and chat ID are correct and that the destination user or group has already started or added the bot. Credentials belong in `.env.telegram`, not `.env`.

### noVNC is unreachable

Check `NOVNC_BIND_ADDRESS`, `NOVNC_PORT`, host firewall rules, and the files under `logs/`. Do not expose port 6080 directly to the public internet.

## Security notes

- The default noVNC port binds only to localhost.
- The login container rejects the example password and passwords shorter than 8 characters. [Traditional VNC authentication only uses the first 8 characters](https://github.com/LibVNC/x11vnc/blob/master/doc/OPTIONS.md), so the localhost binding and SSH tunnel are the important protections.
- Browser profiles, logs, runtime state, and all real environment files are ignored by Git.
- Docker build contexts exclude the same sensitive paths.
- The containers currently run Chromium with `--no-sandbox`; use a dedicated host and do not run untrusted workloads alongside this stack.
- Rotate any credential immediately if it is accidentally committed, even if the commit is later deleted.

## Project status

This project is an experimental personal automation tool. Expect maintenance when Instagram changes its private web APIs. There is currently no license; public visibility does not grant permission to copy, modify, or redistribute the code.
