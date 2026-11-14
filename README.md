# Social Media Stalker

自架的 Instagram、X／Twitter 與 TikTok 監控及封存工具。訂閱帳號後，自動將可存取的內容保存到本機，並透過同一個 Telegram Bot 接收通知、下載連結內容及管理個人訂閱。

適合以 Docker 長期運行，提供持久化佇列、重試、健康檢查與獨立 watchdog。Instagram 使用手動登入的 Chromium 工作階段；X 使用 FxTwitter，歷史回補另需 twscrape 帳號池；TikTok 支援內容監控與 LIVE 錄影。

> [!IMPORTANT]
> Instagram 請使用專用小號，避免主要帳號因驗證、鎖定或停權受到影響。本工具依賴非官方介面與第三方服務；平台變更可能使功能失效。僅處理你有權存取的內容，並遵守平台條款及適用規範。阻擋已讀請求的網路防護不代表匿名保證。

## 目錄

- [功能與平台](#功能與平台)
- [部署前準備](#部署前準備)
- [快速開始](#快速開始)
- [Telegram 操作](#telegram-操作)
- [設定參考](#設定參考)
- [封存與資料目錄](#封存與資料目錄)
- [日常維護與升級](#日常維護與升級)
- [故障排除](#故障排除)
- [開發驗證](#開發驗證)
- [詳細文件與參考](#詳細文件與參考)

## 功能與平台

| 平台 | 自動監控／封存 | 手動操作 | 必要 worker |
| --- | --- | --- | --- |
| Instagram | Story、貼文輪播、精選動態 | 貼文、Reel、Story、精選及分享連結下載 | `ig-watch` |
| X／Twitter | 新貼文與媒體 | 單篇連結下載、歷史回補 | `x-watch` |
| TikTok | LIVE 錄影、貼文／照片、轉發、Story、個人資料變更；可選公開讚好 | 影片、照片及短分享連結下載 | `tiktok-watch`（LIVE）、`tiktok-catalog`（內容／連結） |

- **共用 Bot、個人設定**：白名單使用者各自管理訂閱與通知；同帳號內容只擷取一次，傳送收據按使用者保存。
- **本機封存獨立運作**：關閉通知不會停止下載；取消最後一位訂閱者才停止該帳號後續監控，既有檔案保留。
- **可恢復的背景工作**：下載與傳送分開記錄，重啟後可繼續處理；Telegram 回應遺失時仍可能重複傳送。
- **選用 ZIP 匯出**：在 Telegram 申請單一帳號的既有封存，透過 HTTPS 連結下載，有效期 24 小時。需額外啟用匯出服務及 tunnel。

Instagram 首次貼文／精選掃描會安靜下載可存取歷史，之後的新發現才發媒體通知；加入時仍可讀取的 Story 可立即通知。獨立 Reels 分頁不在自動掃描範圍，但可貼連結下載。已過期或刪除且未保存的內容無法保證恢復。

## 部署前準備

| 項目 | 用途 |
| --- | --- |
| Docker Engine／Docker Desktop 與 Compose v2 | 執行服務；主機需有足夠下載與錄影空間 |
| Telegram Bot token、私人 chat ID | 共用選單與通知；先向 Bot 傳送訊息 |
| Telegram API ID／hash | `igctl` 預設使用的 Local Bot API，填入 `.env.tiktok` |
| 專用 Instagram 帳號 | 啟用 Instagram 時，手動建立登入工作階段 |
| Surfshark OpenVPN service 憑證、TikTok cookies、`/dev/net/tun` | 啟用 TikTok 時使用；LIVE worker 為 `linux/amd64`，ARM 主機需模擬支援 |
| twscrape `accounts.db` | X 歷史回補所需；一般監控與單篇下載另見 X 指南 |

日常監控在 Docker 內運行，不需要主機安裝 Node.js 或 Python。本機 JavaScript 測試與 Telegram Local Bot API 遷移腳本需要 Node.js 22 以上；匯出測試另需 Python 3。

## 快速開始

以下命令均在專案根目錄執行。先建立共用 Telegram 服務，再啟動需要的平台。

### 1. 建立設定檔

全新安裝執行；既有部署請保留原檔，對照範本補上缺少設定。

```sh
cp .env.example .env
cp .env.telegram.example .env.telegram
cp .env.tiktok.example .env.tiktok
chmod 600 .env .env.telegram .env.tiktok
```

編輯以下欄位：

| 檔案 | 必填／初始設定 |
| --- | --- |
| `.env` | `VNC_PASSWORD` 改為唯一且至少 8 字元的密碼；Instagram 初始訂閱填入 `IG_TARGET_USERNAMES=alice,bob`，不用 `@` |
| `.env.telegram` | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`；若 chat ID 是群組負數，另填擁有者的數字 `TELEGRAM_OWNER_USER_ID` |
| `.env.tiktok` | `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`；啟用 TikTok 時另填 VPN 憑證並準備 cookies |

即使只使用 Instagram，`igctl` 也會載入 Local Bot API 設定，因此仍需 `.env.tiktok` 的 API ID／hash。VPN 憑證只在啟動 TikTok 服務時使用。

```sh
./igctl config --quiet
```

此命令僅驗證 Compose 設定，不會確認登入、憑證或平台服務可用。

### 2. 建立 Instagram 登入工作階段

若不使用 Instagram，可跳到下一步。

```sh
docker compose --profile login build ig-login
docker compose --profile login run --rm --service-ports ig-login
```

開啟 [本機 noVNC](http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale)，輸入 `.env` 的 VNC 密碼，使用專用小號登入 Instagram。完成後在終端按 `Ctrl-C`，等到出現 `LOGIN_BROWSER_STOPPED`；登入資料保存在 `data/profile/`。請勿同時讓多個瀏覽器命令使用該 profile。

遠端主機先建立 SSH tunnel，再於自己的電腦開啟上面的網址：

```sh
ssh -L 6080:127.0.0.1:6080 user@your-server
```

檢查登入及網路防護：

```sh
docker compose build ig-check
docker compose run --rm ig-check
docker compose run --rm ig-check node /app/src/guard-selftest.mjs
```

預期分別看到 `SESSION_OK` 與 `GUARD_SELFTEST_PASS`。

### 3. 啟動共用 Telegram 服務

**從雲端 API 切換既有 Bot 前**，先停止其他使用同一 token 的服務，完成 [Local Bot API 遷移](docs/tiktok-integration.md#首次切換既有-telegram-bot)及雲端 `logOut`。同一 Bot 只能有一個收訊 poller。

完成必要的遷移後：

```sh
./igctl up -d telegram-bot-api
./igctl build ig-watch ig-watchdog ig-telegram
./igctl run --rm ig-watch node /app/src/watch-media.mjs --test-telegram
./igctl up -d ig-telegram ig-watchdog
```

測試只傳送文字，不會擷取或傳送 Story。它使用 `TELEGRAM_CHAT_ID`；正常私人選單配送則使用各核准使用者的私人聊天。

### 4. 啟動需要的平台

**Instagram：**

```sh
./igctl up -d ig-watch
```

**X／Twitter：**

```sh
./igctl up -d --build x-watch
```

在 Telegram 傳送 `/xadd alice`。歷史回補另需有效的 twscrape 帳號池，請依 [X 整合說明](docs/x-integration.md)設定。沒有啟動 `x-watch` 時，回補申請會一直停在「等待排入佇列」。

**TikTok：**先完成 [VPN、cookies 與登入設定](docs/tiktok-integration.md)，再執行：

```sh
./igctl up -d --build tiktok-vpn tiktok-browser-resolver tiktok-watch tiktok-catalog
```

在 Telegram 傳送 `/ttadd alice`。LIVE 錄影與內容監控由不同 worker 處理；手動連結下載需要 `tiktok-catalog`，不用先訂閱帳號。

### 5. 確認運行

```sh
./igctl ps
./igctl logs -f ig-watch ig-watchdog ig-telegram
```

在 Bot 的私人聊天傳送 `/start` 或 `/menu`，以 `/status` 查看自己的訂閱與狀態。查看其他平台日誌時，將服務名稱換成 `x-watch`、`tiktok-watch` 或 `tiktok-catalog`。

`igctl` 會合併 `docker-compose.yml`、`compose.watch.yml`、`compose.health.yml`、`compose.x.yml`、`compose.tiktok.yml` 及 `compose.export.yml`。匯出與 tunnel 服務預設透過 profile 關閉。

## Telegram 操作

只有核准使用者的私人聊天可以操作；每位使用者都必須先向 Bot 傳送 `/start`。

| 操作 | 指令／選單 |
| --- | --- |
| 開啟選單／查看狀態 | `/menu`、`/status` |
| 新增 Instagram 訂閱 | `/add alice` 或「新增帳號」 |
| 新增 X／TikTok 訂閱 | `/xadd alice`、`/ttadd alice` |
| 下載連結 | 直接貼上連結，或 `/download <連結>` |
| X 歷史回補 | `/xhistory alice`；指定 UTC 日期範圍：`/xhistory alice 2024-01-01 2025-01-01`，不含結束日 |
| 調整通知／取消訂閱 | 對應平台的帳號選單 |
| 每日摘要 | 主選單「通知」啟用；預設關閉，啟用後於香港時間每日 20:00 發送 |
| 取消輸入 | `/cancel` |
| 匯出已保存內容 | 帳號選單「📦 匯出全部封存」；需先完成匯出部署 |

主選單只有 Instagram、X／Twitter、TikTok、通知及狀態五個入口。各平台直接列出你的監看帳號、簡短狀態與支援功能，Instagram／X 帳號下方也會顯示進行中的回補或封存進度與排隊狀態；下方可選擇帳號或新增帳號。「通知」內的媒體總開關只影響你自己，重新開啟時保留各帳號細項，也不補發關閉期間的內容；每日摘要另設開關。連結直接傳入聊天室即可下載，沒有獨立下載入口。

選單切換、設定變更、重新整理及帳號輸入會更新原訊息；原訊息已刪除或無法編輯時才建立替代選單。狀態頁使用一致的三平台格式，只有進行中或排隊的 X 回補才顯示；預計完成時間依可用的封存速度估算，資料不足或限流時顯示「暫時無法估算」。回補的進度與結果更新同一則通知。

異常通知在恢復後自動刪除，不另發恢復訊息。這需要保存 Telegram 訊息 ID；升級前未保存 ID 的舊通知，以及 Telegram 已不允許刪除的訊息，無法保證自動清除。

擁有者由 `TELEGRAM_OWNER_USER_ID` 指定，未設定時使用正數 `TELEGRAM_CHAT_ID`。其他核准使用者填入 `.env.telegram` 的 `TELEGRAM_ALLOWED_USER_IDS`，修改後重新建立 `ig-telegram`。擁有者永遠在核准名單內；群組訊息與未核准使用者會被忽略。

初次啟動會把環境變數中的 Instagram 訂閱匯入擁有者設定。之後請透過 Telegram 管理，修改 `.env` 不會覆寫已儲存的選擇；新使用者從空清單開始。設定保存在 `data/control/`，重啟不會清除。

### 手動連結下載

Instagram 支援貼文、Reel、Story、精選及分享連結；貼文／Reel 會下載完整輪播，精選連結下載整個可存取集合。帳號首頁會先詢問是否加入訂閱。IG／X 每則訊息合計最多十個連結，每個連結獨立排程。

TikTok 支援 `/@帳號/video/ID`、`/@帳號/photo/ID` 與 `vm.tiktok.com`、`vt.tiktok.com`、`tiktok.com/t/` 分享連結。手動下載不需要先訂閱該帳號，也不受自動通知開關影響。

檔案先下載到本機，再交由 Telegram 傳送。Instagram 會選取可用的高解析度／位元率；需要合併音軌時使用 FFmpeg stream copy。無法以照片／影片顯示的內容可改以文件傳送；超過傳送上限的檔案留在本機並回報。上傳結果不確定時，系統會請你先確認聊天內容；重新貼連結代表明確申請再次傳送。

完整佇列、快取、重試與傳送規則見 [Instagram 操作細節](docs/instagram-operations.md#download-an-instagram-link)。

## 設定參考

以下為常用設定；平台專屬選項請查看範本及整合指南。

| 變數 | 檔案 | 預設／行為 |
| --- | --- | --- |
| `IG_TARGET_USERNAMES` | `.env` | 初始訂閱，以逗號分隔；非空時優先於舊版單帳號變數 |
| `IG_TARGET_USERNAME`／`IG_TARGET_USER_ID` | `.env` | 舊版單帳號模式；僅清單為空時使用，數字 ID 可略過查詢 |
| `IG_CHECK_INTERVAL_SECONDS` | `.env` | Story 間隔 `300` 秒；範圍 `60–86400` |
| `IG_CATALOG_ENABLED` | `.env` | `1`；設為 `0` 停用貼文／精選掃描，保留 Story 封存 |
| `IG_POSTS_INTERVAL_SECONDS`／`IG_HIGHLIGHTS_INTERVAL_SECONDS` | `.env` | 各 `900` 秒；範圍 `300–86400` |
| `IG_DOWNLOAD_DIR` | `.env` | `./downloads`；容器內掛載至 `/downloads` |
| `IG_DATA_DIR`／`IG_LOG_DIR` | `.env` | `./data`／`./logs` |
| `VNC_PASSWORD` | `.env` | 登入時必填，拒絕範例密碼與少於 8 字元的密碼 |
| `NOVNC_BIND_ADDRESS`／`NOVNC_PORT` | `.env` | `127.0.0.1`／`6080` |
| `IG_TELEGRAM_CONTROL` | `.env` | Compose 預設 `1`；`0` 使用舊版單一目的地配送，選單設定不會回寫環境變數 |
| `TELEGRAM_BOT_TOKEN`／`TELEGRAM_CHAT_ID` | `.env.telegram` | Bot 憑證及舊版／測試目的地 |
| `TELEGRAM_OWNER_USER_ID` | `.env.telegram` | 擁有者數字 ID；舊 chat ID 為群組時需明確設定 |
| `TELEGRAM_ALLOWED_USER_IDS` | `.env.telegram` | 其他核准使用者的數字 ID，以逗號分隔 |
| `TELEGRAM_API_ID`／`TELEGRAM_API_HASH` | `.env.tiktok` | Local Bot API 所需 |
| `ARCHIVE_EXPORT_ENABLED` | `.env` | `0`；完成 HTTPS 匯出部署後才啟用 |

修改容器設定後，重新建立對應服務，例如：

```sh
./igctl up -d --force-recreate ig-watch ig-telegram
```

## 封存與資料目錄

預設主機目錄如下；修改 `IG_DATA_DIR`、`IG_DOWNLOAD_DIR` 或 `IG_LOG_DIR` 時，以實際掛載為準。TikTok cookies 預設仍使用 `./data/tiktok/cookies.json`。

```text
downloads/
  instagram/
    alice/
      stories/
      posts/                  # 輪播媒體與 caption.txt
      highlight/
    manual/<username>/        # 手動下載與 manifest.json
  x/
  tiktok/
    <username>/live/          # 完成的 LIVE MP4

data/
  profile/                    # Instagram 登入資料
  control/                    # 個人設定、Bot 更新位置、傳送收據及冷卻狀態
  watch/                      # 封存索引、下載佇列、平台健康及工作狀態
  watchdog/                   # 告警與傳送狀態
  x-accounts/                 # twscrape accounts.db
  tiktok/                     # TikTok cookies
  exports/                    # 選用 ZIP、申請與連結狀態
logs/                         # 本機稽核與 GUI 日誌
```

Instagram 媒體檔名使用發佈時間的 JST；Story 無發佈時間時使用偵測時間。貼文與精選編號持久保存，caption 更新不會重送媒體。內容在平台刪除後，本機檔案仍保留；下載檔案沒有自動到期清理，已成功封存但被手動刪除的檔案不會自動補回。

**備份應包含下載、完整狀態、登入資料及必要的 Docker volumes。** Local Bot API 與 TikTok 瀏覽器 profile 使用 named volumes；只複製 `data/` 不包含這些資料。`.env*`、cookies、資料庫、收據、匯出連結與狀態都屬私人資料，不要提交 Git 或附於 issue。

ZIP 匯出只處理當時的本機封存，不代表來源平台歷史已完整抓取。下載網址持有者即可存取，請謹慎分享。權限、24 小時生命週期、磁碟需求及 Mac／NAS 的 Cloudflare Tunnel 設定見 [封存匯出說明](docs/archive-export.md)。

## 日常維護與升級

```sh
# 查看服務／追蹤日誌
./igctl ps
./igctl logs -f ig-watch ig-watchdog ig-telegram

# 重新建置並建立更新後的服務
./igctl up -d --build --force-recreate ig-watch ig-watchdog ig-telegram

# 停止整套服務，保留 named volumes
./igctl down
```

升級前先停止舊 watcher 與其他寫入相同資料的程序，私下備份 `data/`、`downloads/`、設定與 named volumes。不要使用 `down -v` 清理部署，也不要刪除 `.required`、封存索引或傳送收據來重試下載。

舊版 Instagram 封存會在初始化時遷移至 `downloads/instagram/`，以 journal 記錄搬移進度；帳號目錄按數字 ID 維持穩定。遇到來源歸屬不明、symlink 或目的地衝突時會停止遷移，不覆寫檔案。升級期間保留舊帳號設定，不要自行搬移帳號目錄或刪除 `archive-layout.json` 及 marker。詳見 [既有下載遷移](docs/instagram-operations.md#upgrading-existing-downloads)。

### 診斷命令

對指定 Instagram 帳號執行一次 Story 擷取，不傳 Telegram：

```sh
docker compose run --rm -e IG_TARGET_USERNAME=alice -e IG_TARGET_USER_ID= -e IG_TARGET_USERNAMES= ig-check node /app/src/fetch-story.mjs
```

執行一次完整 Instagram 檢查與配送；請先停止使用同一 profile 的常駐 watcher：

```sh
./igctl stop ig-watch
./igctl run --rm ig-watch node /app/src/watch-media.mjs --once
./igctl up -d ig-watch
```

測試 watchdog 告警路徑（會排入測試告警）：

```sh
./igctl exec ig-watchdog node /app/src/watchdog.mjs --self-test
```

## 故障排除

| 現象／日誌 | 檢查與處理 |
| --- | --- |
| `SESSION_INVALID` | 停止 `ig-watch`，重新執行登入步驟，完成後檢查 session 並啟動 watcher |
| `BOOTSTRAP_TOKEN_ERROR`、GraphQL／schema 錯誤 | 查看日誌；Instagram 頁面或私有 API 可能已變更，必要時調整查詢 ID，避免反覆強制重試 |
| Telegram 測試失敗 | 檢查 `.env.telegram` 的 token、chat ID，以及使用者是否已向 Bot 傳送訊息；確認 Local Bot API 設定及遷移已完成 |
| Bot 不回應 | 確認使用私人聊天、數字使用者 ID 在白名單、`ig-telegram` 健康，且沒有其他 poller 或既有 webhook |
| X 回補一直等待 | 啟動 `x-watch`；再確認有效的 `accounts.db` 與 X 指南中的狀態命令 |
| TikTok 403／CAPTCHA | 依 TikTok 指南檢查 VPN、cookies 與互動登入；catalog 與登入容器不可同時使用共用 profile |
| noVNC 無法連線 | 檢查綁定位址、連接埠、防火牆及 `logs/`；遠端使用 SSH tunnel |
| 有 Telegram 訊息，但找不到本機檔案 | `STORY_MEDIA_SENT` 只代表配送；確認 `STORY_ARCHIVE_SAVED`／`CATALOG_MEDIA_SAVED` 與主機實際掛載 |
| 磁碟、權限、歷史／marker 錯誤 | 保留狀態及備份，處理根因；不要以刪除索引或 marker 的方式略過保護 |

Instagram 可恢復的擷取、下載及配送錯誤連續三次才通知一次，前兩次安靜重試；成功後重設計數；私人選單配送會清除已告警問題的通知，不另發恢復訊息。登入、儲存及資料完整性問題立即告警。共用登入失效會暫停所有 Instagram 帳號；個別帳號錯誤則獨立退避。

一般使用者只看到與自己相關的狀態；共用服務故障的技術細節限擁有者。watchdog 在控制服務失效時可直接發送備援警告。

## 開發驗證

```sh
npm ci
npm test
npm run test:export
./igctl config --quiet
```

`npm test` 包含 JavaScript 語法檢查與 Node 測試；`test:export` 執行 Python 匯出測試。平台專屬驗證見各整合指南。離線測試通過不代表真實登入、平台介面、VPN、直播或 Telegram 大檔傳送已驗證。

網路防護以允許清單限制 Instagram 唯讀請求，阻擋已知 Story seen／read mutation 及非預期寫入。noVNC 預設僅綁 localhost；傳統 VNC 驗證只使用密碼前八個字元，應維持 localhost 並使用 SSH tunnel。Chromium 容器目前使用 `--no-sandbox`，部署時請使用專用環境。若憑證曾外洩，應立即更換。

## 詳細文件與參考

| 文件 | 內容 |
| --- | --- |
| [Instagram 操作與封存細節](docs/instagram-operations.md) | 完整封存規則、遷移、私人選單、手動下載與傳送狀態；保留原英文技術說明 |
| [X／Twitter 整合](docs/x-integration.md) | 啟用、twscrape 帳號池、歷史回補與故障恢復 |
| [TikTok 整合](docs/tiktok-integration.md) | LIVE、VPN、cookies、Local Bot API 遷移、catalog 與登入 |
| [封存匯出](docs/archive-export.md) | ZIP、HTTPS 下載、Cloudflare Tunnel、Mac／NAS 部署與移轉 |

參考專案：[tiktok-live-recorder](https://github.com/Michele0303/tiktok-live-recorder)、[twscrape](https://github.com/vladkens/twscrape)、[TelegramSocialDownloader](https://github.com/Senachi124/TelegramSocialDownloader)。另整合本機 TikTok-Recorder、ig-story-browser 與 x_download_tool 的相關實作。

此專案為實驗性個人自動化工具，需要隨平台介面變動維護。目前沒有專案整體授權；內含 TikTok 程式碼的授權見 [tiktok/LICENSE](tiktok/LICENSE)。
