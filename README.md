# IG Story Stalker

A self-hosted Instagram Story watcher that reuses a manually authenticated Chromium profile, checks one or more accounts for new Stories, delivers available photos and videos to Telegram, and archives Stories, posts, and Highlights to disk.

The project is designed for unattended Docker deployments. It includes a fail-closed network guard, persistent delivery state, health checks, a supervising worker, and an independent watchdog.

> [!WARNING]
> This is an unofficial tool built on Instagram's private web APIs. Those APIs and document IDs can change without notice. Use it only for accounts and content you are authorized to access, comply with applicable terms and laws, and do not treat the read-receipt guard as a guarantee of anonymity.
>
> **Do not use your primary or personal Instagram account.** Use a dedicated secondary account whose loss, lockout, or challenge would not affect your main account. Its authenticated browser profile is stored locally under `data/profile/`.

## Features

- Manual Instagram login through a temporary noVNC container
- Persistent Chromium session stored outside the image
- Multiple target accounts with independent download folders, delivery history and retries
- Private Telegram menus with whitelisted users, personal subscriptions and notification preferences
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
downloads/instagram/
  alice/
    stories/20261016_013000_JST_123456.mp4
    posts/00001_20261016_013000_JST/
      01.jpg
      02.mp4
      caption.txt
    highlight/01_旅行/
      001_20261016_013000_JST.jpg
  bob/
    stories/
    posts/
    highlight/
```

When upgrading an existing installation, stop all old watcher processes before
starting the new version. The watcher moves registered Instagram account folders
and the old `downloads/manual/` folder into `downloads/instagram/`. It keeps a
migration journal and refuses to overwrite conflicting folders. Keep a private
backup of the download and state directories before upgrading.

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

All accounts share the saved Instagram login and polling settings. Each approved
Telegram user has their own private subscriptions and notification switches. A target
followed by several users is fetched and archived once, while each user's delivery
acknowledgements and retries remain independent. Disabling notifications never disables
local archiving. Removing the last subscription stops future work for that target;
an in-flight check/download may finish. Files and history remain on disk.

Checks run sequentially, with a two-second pause between accounts; a slow account can
delay later accounts. Each account has independent fetch backoff, archive queues,
post numbering and baseline scans. A failed lookup, fetch, or damaged account history
leaves other accounts running. Damaged histories are never replaced with empty state;
account initialization/storage failures retry every five minutes and remain visible
in health. A shared login/challenge failure pauses all accounts, emits an alert, and
probes the login every five minutes before resuming.

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

### Upgrading existing downloads

Stop the old watcher before upgrading, and keep a private backup of `data/` and
`downloads/`. On the first successful initialization, the worker moves the old root
`stories/`, `posts/` and `highlight/` directories under their original account folder.
It identifies ownership from the numeric-ID histories, preserves those histories and
Telegram sent IDs, and records the layout in `data/watch/archive-layout.json` plus
its `.required` marker. A journal resumes interrupted directory moves after restart.
Do not delete these layout files or move account folders manually.

The old account can appear anywhere in the new list. If it is removed or cannot be
resolved during migration, its retained archive uses its numeric ID as the folder
name. Accounts named `stories`, `posts`, or `highlight` use `<username>_<ID>` to avoid
colliding with legacy directories. Folder assignments remain stable by numeric ID
if a username later changes. Removed accounts' files and histories remain on disk.

If legacy ownership is ambiguous, the destination already contains conflicting
files, or a directory is a symlink, migration fails visibly without overwriting
files. Resolve the reported layout conflict using your backup before retrying.
Keep the old account configured during the upgrade so its outstanding supervisor
alerts can also migrate and recover under the correct account identity.

TikTok 多帳號貼文／轉發／Story／個人資料監控、LIVE 錄影、共用 Local Bot API 與啟用步驟請見 [TikTok 整合說明](docs/tiktok-integration.md)。

## Requirements

X／Twitter 功能、帳號池設定與升級步驟請見 [X 整合說明](docs/x-integration.md)。

- Docker Engine with Docker Compose v2
- A Telegram bot token and destination chat ID
- The target accounts' Instagram usernames
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

- `IG_TARGET_USERNAMES=alice,bob,charlie` supplies the initial owner subscriptions (usernames only, without `@`). Whitespace is trimmed and duplicate names are ignored, case-insensitively. Once Telegram settings are initialized, manage subscriptions through the menu; editing the environment does not overwrite saved choices.
- A nonempty `IG_TARGET_USERNAMES` takes precedence over both legacy target variables. Each username is resolved separately; a stale `IG_TARGET_USER_ID` cannot override the list.
- If the list is unset or empty, the original `IG_TARGET_USERNAME` and optional `IG_TARGET_USER_ID` still work. In legacy mode a numeric ID skips lookup.
- `IG_CHECK_INTERVAL_SECONDS` must be between 60 and 86400.
- `VNC_PASSWORD` must be unique and at least 8 characters.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` control delivery.

Automatic lookup runs once per account per worker lifetime; failed lookups retry independently. It uses
the saved Instagram session to read the target profile page and extract its numeric ID
from embedded account or route data. It updates only the running process environment and keeps
history keyed by numeric ID. It does not write to `.env`. Lookup failures (including rate limits or an unexpected account response) back off
for that account while other targets continue. An expired shared session pauses all targets. `TARGET_RESOLVED` records a successful lookup.
The Telegram-only test does not require an Instagram lookup. It uses the legacy
`TELEGRAM_CHAT_ID` destination; normal controlled delivery uses each approved user's private chat.

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
./igctl build ig-watch ig-watchdog ig-telegram
./igctl run --rm ig-watch node /app/src/watch-media.mjs --test-telegram
```

The test sends a text message only. It does not fetch or deliver a Story.

### 5. Start continuous monitoring

```sh
./igctl up -d ig-watch ig-watchdog ig-telegram
./igctl ps
./igctl logs -f ig-watch ig-watchdog ig-telegram
```

要啟用 X／Twitter 監控與歷史回補，還必須啟動 X worker：

```sh
./igctl up -d x-watch
```

只啟動上面的三個 IG／Telegram 服務，回補申請會一直顯示「等待排入佇列」。
歷史回補還需要有效的 twscrape `accounts.db`；設定方式見 [X 整合說明](docs/x-integration.md)。

Stop all monitoring services with:

```sh
./igctl down
```

`igctl` combines `docker-compose.yml`, `compose.watch.yml`, and `compose.health.yml`. The resulting deployment runs the media watcher under a supervisor and keeps the independent watchdog and Telegram control service in separate containers.

## Telegram private menus

Send `/start` or `/menu` to your bot in a **private chat**. The command menu offers:

- **監看帳號** / **新增帳號**: add a username such as `alice` or `@alice`, or confirm
  removing a subscription. `/add alice` is also supported.
- **媒體通知**: select an account and independently enable/disable Story, post and
  Highlight notifications. All three are enabled by default; local downloads continue.
- **每日摘要**: disabled by default. When enabled, receive one personal summary per
  Hong Kong calendar day at 20:00. If the service starts after that time, today's
  summary is queued then. Account errors and recovery alerts remain enabled.
- **我的狀態** / `/status`: view only your subscriptions and relevant incidents.
  `/cancel` exits an account-entry prompt.

The owner is `TELEGRAM_OWNER_USER_ID`, or the positive private-user
`TELEGRAM_CHAT_ID` when the owner variable is omitted. If the old destination is a
group (negative chat ID), explicitly configure the owner's **numeric user ID**.
Add other approved IDs to `TELEGRAM_ALLOWED_USER_IDS=123456789,987654321` in
`.env.telegram`, then recreate **ig-telegram**. Each user must start the bot privately
before it can send them messages. Group messages and callbacks, unknown users, and
callbacks whose private chat does not match the sender are ignored. The owner is
always approved. Revoked users retain saved history but stop receiving messages and
stop contributing targets to the active watch list.

On first startup, `ig-telegram` imports the environment's target list into the owner's
settings and migrates acknowledged Story IDs. New users start with an empty list.
It persists choices under `data/control/`; changes reach the worker at its next
settings refresh (normally within five seconds when idle, or after the current cycle).
The worker keeps its normal Instagram scan interval. Settings survive restarts and
are never overwritten by the initial environment list. An empty subscription list
is valid and leaves the worker idle.

Adding an account sends its currently available Stories, subject to your switches.
Existing posts/Highlights download quietly. Historical posts/Highlights first found
after a new subscription are also kept quiet using their publication time. Turning
a notification switch back on does not replay already observed or queued content
from the disabled period; only subsequent discoveries are eligible. This uses first
detection time: content not observed until after re-enabling is a new discovery,
even when its publication time is earlier. New subscriptions separately suppress
historical posts/Highlights using publication time. Media already
acknowledged for one user is not resent if another user fails. Telegram can still
produce a duplicate if its acknowledgement is lost after delivery.

Account-specific alerts go to the users subscribed to that account. Shared login,
storage-capacity and service failures go to all approved users. The watchdog routes
alerts through the control service; if that service or its polling heartbeat fails,
it sends a separate direct fallback warning. A blocked recipient does not prevent
other users from receiving replies or fallback alerts.

Only **one** `ig-telegram` instance may poll a given bot token. An existing webhook
is reported as a configuration error, never deleted automatically. A Telegram 429
cooldown is persisted and shared between normal menu/media requests. The independent
watchdog fallback has its own persisted cooldown. The bot uses the official
[Telegram Bot API](https://core.telegram.org/bots/api#getupdates).

To enable this feature on an existing deployment:

```sh
./igctl up -d --build --force-recreate ig-watch ig-watchdog ig-telegram
```

Compose enables `IG_TELEGRAM_CONTROL=1` by default. Set it to `0` in `.env` and
recreate the stack to use the legacy environment-driven, single-destination delivery;
the control container then stays idle and does not poll or change saved settings.
Switching to legacy mode does not synchronize menu subscriptions back to `.env`.

`data/control/settings.json` and `delivery.json`, plus their `.required` markers,
protect personal settings, update offsets and delivery history. Do not delete them
to retry a notification. Delivery state and `data/watch/telegram-events/` may contain
signed media URLs and user IDs. Include `data/control/` in private backups, and keep
it out of Git/support attachments. Account archives retain their existing locations.

## Download an Instagram link

In the bot's private chat, paste a post, Reel, Story, Highlight or Instagram share
link. `/download <link>` and the **連結下載** menu entry are also available. Each
message accepts up to ten links; each link is an independent durable job. Invalid
or unavailable links are reported without discarding other valid jobs. This uses
the existing approved-user list and saved Instagram login. Content must be
accessible to that login. No separate login or extra bot token is needed.

- A post/Reel downloads the whole carousel, in its original order; `img_index` and
  tracking parameters do not limit the selection.
- A Story URL downloads exactly the specified Story. An expired/deleted Story can
  be returned from a complete manual cache, but cannot otherwise be recovered.
- A Highlight URL downloads the whole accessible collection. Collection membership
  is refreshed on each request, while complete media files are reused.
- An account homepage prompts **加入 @account / 取消**. Only confirmation adds it to
  that user's existing subscriptions; a homepage never triggers a bulk archive.
- Repeating a link requests delivery again. Complete post/Story files are reused
  after checking their size and signature; requests have independent delivery receipts.
- Manual results bypass automatic Story/post/Highlight notification switches.
  They do not automatically subscribe the requester to the source account.

The worker finishes its current read/download, then gives queued manual jobs
priority at the next safe boundary. Manual and background Instagram operations use
one serialized browser profile. Menus and Telegram polling continue in a separate
service. Background scans resume after due manual jobs, without losing their
pagination or download checkpoints.

Downloads choose the highest available resolution/bitrate. When a higher-quality
DASH version has separate audio/video tracks, FFmpeg combines them with `-c copy`,
without re-encoding. The worker image includes FFmpeg. Original media and captions
are retained permanently under:

```text
downloads/instagram/manual/<username>/<post|story|highlight>/<content-id>/
  001_<media-id>.jpg
  002_<media-id>.mp4
  manifest.json
```

Reels use the `post` directory. The complete manifest includes the source URL,
caption and ordered file records. Partial-job metadata remains in `data/watch/manual/`.
There is no automatic deletion of these downloaded files. Each source stream has a
2,000,000,000-byte download ceiling, a five-minute transfer timeout, and up to three
job attempts; larger/unavailable sources are reported. DASH source tracks and the
merged file can coexist temporarily, so allow space for both.

Telegram results are uploaded from local files, rather than asking Telegram to
fetch Instagram's expiring CDN URLs. Photos/videos form albums of at most ten items,
in order; a single item is sent normally. Oversized photos or rejected display
formats can be sent as original documents, in separate document groups when needed.
Before uploading, the controller probes the final local MP4 with ffprobe and supplies
display width, height and duration to Telegram, accounting for rotation and pixel
aspect ratio. It also extracts an upright JPEG preview (at most 320 pixels per
side, preserving the display ratio) and uploads it as both thumbnail and cover
for single videos and albums. This also applies to cached videos without
re-encoding the original. If probing or preview extraction fails, the original
group is sent as documents to preserve order and receipt boundaries. The
controller image includes ffprobe and FFmpeg.
The current cloud API file ceiling is 50 MB. Files above that ceiling stay local;
other transferable media are sent and the bot reports **檔案過大，已下載但無法直接傳送**.
This feature does not start a Local Bot API server or an external download website.

Temporary fetch/download failures retry while complete files remain available for
reuse. After retries, successfully downloaded items are still sent with a partial
failure report. Telegram group acknowledgements are persisted individually. A
network timeout or a restart during an in-flight upload is treated as uncertain:
files stay local and the bot asks the user to check their chat; it does not blindly
upload that group again. Reposting the link creates a new explicit request.
Confirmed rate-limit rejections can retry after the shared Telegram cooldown.

Settings/update offsets and manual requests are saved together in
`data/control/settings.json`. The watcher owns `data/watch/manual/jobs/` and its
cache index; the controller owns `data/control/manual-delivery.json` and its
`.required` marker. Keep all of these in private backups. Do not delete receipt
state to retry an upload. The controller's `/downloads` mount is read-only, and
only the watcher writes media. No Instagram seen/read mutation is allowed.

After upgrading, recreate the services so that FFmpeg and the read-only download
mount are present:

```sh
./igctl up -d --build --force-recreate ig-watch ig-telegram ig-watchdog
```

## Configuration

| Variable | File | Required | Description |
| --- | --- | --- | --- |
| `IG_TARGET_USERNAMES` | `.env` | Unless legacy target is supplied | Comma-separated usernames; takes precedence over legacy variables |
| `IG_TARGET_USERNAME` | `.env` | Legacy fallback | Single account username, used when the list is empty |
| `IG_TARGET_USER_ID` | `.env` | No | Optional ID override in legacy single-account mode only |
| `IG_CHECK_INTERVAL_SECONDS` | `.env` | No | Base polling interval; defaults to `300` |
| `VNC_PASSWORD` | `.env` | For login | Password for the temporary noVNC session |
| `NOVNC_BIND_ADDRESS` | `.env` | No | Host address for noVNC; defaults to `127.0.0.1` |
| `NOVNC_PORT` | `.env` | No | Host port for noVNC; defaults to `6080` |
| `IG_DATA_DIR` | `.env` | No | Host runtime-data directory; defaults to `./data` |
| `IG_LOG_DIR` | `.env` | No | Host log directory; defaults to `./logs` |
| `TELEGRAM_BOT_TOKEN` | `.env.telegram` | Yes | Telegram bot token |
| `TELEGRAM_CHAT_ID` | `.env.telegram` | Yes | Legacy/test destination; also the default owner ID when positive |
| `TELEGRAM_OWNER_USER_ID` | `.env.telegram` | For group migrations | Owner numeric user ID; defaults to a positive `TELEGRAM_CHAT_ID` |
| `TELEGRAM_ALLOWED_USER_IDS` | `.env.telegram` | No | Additional approved private users, comma-separated; recreate ig-telegram after changes |
| `IG_TELEGRAM_CONTROL` | `.env` | No | Compose defaults to `1`; `0` retains legacy delivery |

## Useful commands

Run one Story fetch for a selected username without Telegram delivery (replace `alice`):

```sh
docker compose run --rm -e IG_TARGET_USERNAME=alice -e IG_TARGET_USER_ID= -e IG_TARGET_USERNAMES= ig-check node /app/src/fetch-story.mjs
```

Run one complete media check and delivery cycle for all configured accounts:

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
- `data/control/` — personal Telegram settings, update offsets, notification queues and API cooldowns
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
    watch-media  -----> durable events -----> telegram-control -----> private Telegram
          |                                     |
          |                                  personal menus
          |
          +-----> durable state + health files
                         |
                         v
                      watchdog -----> Telegram alerts
```

The browser worker bootstraps an authenticated Instagram page and performs one allow-listed Story GraphQL query per configured numeric account ID, sequentially. Profile post scans accept an original producer or an explicitly confirmed coauthor;
invited collaborators and unrelated accounts are rejected. The network guard blocks known seen/read operations and rejects other Instagram write requests. Story media URLs are passed through a private temporary file, delivered to Telegram, and never written to the audit log.

## Troubleshooting

Instagram 的 Story、貼文／精選查詢、媒體下載及傳送遇到可恢復錯誤時，連續失敗三次才列為異常並通知一次；前兩次安靜重試。成功後會重設次數，只有已發出告警的問題才發恢復通知。計數按帳號及工作分開並保存於監控狀態；Telegram 限流等待本身不算新失敗。登入失效、磁碟／權限及資料完整性問題仍立即告警。TikTok 的同類規則見 [TikTok integration](docs/tiktok-integration.md)。

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
