# Instagram 操作與封存細節

[返回 README](../README.md)

本頁保留 Instagram 封存、升級、私人選單及手動下載的完整操作細節。首次部署請先閱讀 README；X、TikTok 與 ZIP 匯出另有各自指南。

## Instagram media downloads

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
storage-capacity and service failures notify all approved users, but only the owner
receives technical details. Other users receive a generic service-unavailable message
(or a brief recovery message). Shared incident details in status queries and daily
summaries are also restricted to the owner. The watchdog routes
alerts through the control service; if that service or its polling heartbeat fails,
it sends a separate direct fallback warning, with technical instructions only for the owner. A blocked recipient does not prevent
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
The supplied `igctl` stack uses the Local Bot API, with a 2,000 MB single-file limit; the cloud API has a 50 MB upload limit. Files above the applicable limit stay local;
other transferable media are sent and the bot reports **檔案過大，已下載但無法直接傳送**.
The Local Bot API server is provided by the Compose stack.

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
