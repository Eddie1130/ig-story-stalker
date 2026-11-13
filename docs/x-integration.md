# X／Twitter 監控與歷史封存

X 功能直接整合於現有 Node.js／Docker 架構，不需要 n8n 或額外的 NAS HTTP 接收服務。Instagram 與 X 共用 Telegram bot、私人聊天白名單、使用者訂閱設定及下載根目錄。日常監控使用 FxTwitter；歷史回補由獨立 Python 子程序使用 twscrape，與日常輪詢並行。

## 啟動與升級

保留並備份既有 `data/`、`downloads/`、`.env` 及 `.env.telegram`。新增設定皆有預設值，不需改寫現有登入資料：

```sh
./igctl build x-watch ig-telegram
./igctl up -d --force-recreate ig-telegram x-watch
./igctl logs -f x-watch ig-telegram
```

上述命令只升級 Telegram 並啟動 X worker；既有 IG 服務可繼續執行。完整部署可使用 `./igctl up -d`。`igctl` 現在會同時載入 `compose.x.yml`。

| 設定 | 預設 | 用途 |
| --- | --- | --- |
| `X_ENABLED` | `1` | 設為 `0` 停用 X worker 與 X 傳送；設定與檔案保留 |
| `X_TARGET_USERNAMES` | 空白 | 逗號分隔帳號，只在**全新 Telegram 設定初始化**時匯入擁有者訂閱；既有部署請使用選單 |
| `X_CHECK_INTERVAL_SECONDS` | `300` | 輪詢間隔，60–86400 秒 |
| `X_HISTORY_ENABLED` | `1` | 設為 `0` 暫停歷史任務，保留佇列；日常 FxTwitter 監控仍執行 |
| `X_ACCOUNTS_DIR` | `./data/x-accounts` | 主機端 twscrape 帳號池目錄，內含 `accounts.db` |
| `IG_DOWNLOAD_DIR` | `./downloads` | IG 與 X 共用的主機下載根目錄 |

修改 `.env` 後以 `./igctl up -d --force-recreate x-watch ig-telegram` 套用。X worker 使用只讀 Telegram 設定掛載，Telegram 控制服務使用只讀下載掛載；只有 X worker 操作 X 封存與帳號池。

X 功能需要 `IG_TELEGRAM_CONTROL=1`（既有預設值）。若使用 `IG_TELEGRAM_CONTROL=0` 的 IG 舊模式，X worker 會保持停用，不讀取或建立訂閱設定。

## Telegram 操作

在 bot 的私人聊天開啟 `/menu`，選擇 **X / Twitter**。沿用 `TELEGRAM_OWNER_USER_ID`／`TELEGRAM_ALLOWED_USER_IDS`，群組聊天不接受控制操作。

- `/xadd alice`：新增你自己的 X 訂閱，也可在選單操作。
- 每個帳號可分別切換原創、轉發、回覆、引用的通知。關閉通知仍持續封存。
- `/xhistory alice` 或帳號選單的 **一鍵歷史回補**：自動取得帳號建立日，抓到此次任務啟動當天，免填日期。
- `/xhistory alice 2024-01-01 2025-01-01`：自訂 UTC 日期，**不包含結束日**；結束日期最多為申請當天的 UTC 明天。
- `/status`：查看自己的監控狀態、已封存／待下載數、回補進度與帳號池數量。
- 貼上 `https://x.com/alice/status/123`、`twitter.com` 或 `fxtwitter.com` 單篇連結即可下載；`/download <連結>` 亦可。每則訊息 IG／X 合計最多十個連結。帳號首頁會先詢問是否加入訂閱，不直接執行全歷史下載。

回補狀態會列出目前步驟、固定 UTC 日期範圍、四輪搜尋各自的完成數、成功視窗／總數／百分比、剩餘視窗與正在處理的日期段；限流時列出香港時間的下次嘗試時間。搜尋完成後，會另外顯示匯入及本機封存已處理／待處理的**貼文篇數**，不是媒體檔案數。搜尋 100% 不代表媒體已下載完畢；只有全部階段結束才顯示「封存完成」。

每次 `/status` 或點選「我的狀態」會取得新的快照；先前發出的 Telegram 訊息不會自行更新。每個使用者只會看見自己目前訂閱目標的共用回補，以及自己的相關申請。顯示兩筆較詳細的進行中任務，其他近期任務以摘要呈現，避免超過 Telegram 訊息長度。

多人訂閱同一目標時，抓取與本機封存共用一次，個人通知與傳送收據獨立。第一次成功輪詢只建立基準並封存，不通知既有貼文；新使用者加入已監控的帳號，也不重送先前內容。移除最後一位訂閱者後停止該目標未來的輪詢與媒體工作；已開始的讀取或下載可能完成，既有檔案與進度保留。

日常通知上傳本機圖片／影片，以最多十件的相簿分組，並傳送完整文字與來源連結。Telegram 雲端檔案限制沿用 50 MB，過大檔案留在本機並回報。未知傳送結果會標示為不確定，不自動重送該組；需要時重新貼上連結。手動下載不需要訂閱，亦不受自動通知開關影響。

## 設定 twscrape 帳號池

日常 FxTwitter 抓取不需要這個登入池；歷史回補需要至少一個有效的 X 登入 session。憑證只由管理員在主機端處理，不透過 Telegram 傳送。

已有 `accounts.db` 時，將它放到 `X_ACCOUNTS_DIR` 下。若原程序正在使用 SQLite，先停止原程序或使用 SQLite 備份工具；請勿只複製仍有未提交 WAL 的主檔。

新增或更新登入 cookies 時，可在一次性容器內使用 twscrape 的安全互動提示：

```sh
./igctl stop x-watch
./igctl run --rm --no-deps x-watch twscrape --db /app/x-accounts/accounts.db add_cookie archive01
./igctl run --rm --no-deps x-watch python3 /app/x_history_worker.py status --accounts-db /app/x-accounts/accounts.db
./igctl up -d x-watch
```

`archive01` 是本機帳號池識別名稱。第一個指令後的互動提示需要 `auth_token` 與 `ct0`；不要把它們放進命令參數、Git 或支援日誌。Cookie 設定及 CLI 的官方說明見 [twscrape](https://github.com/vladkens/twscrape)。帳號池目錄應限管理員存取；Telegram 只顯示計數，不顯示 cookies、密碼或登入帳號身份。

沒有可用帳號或帳號被限流時，回補保留 SQLite 進度並等待重試；日常監控持續執行。帳號池異常與恢復會通知 bot 擁有者。

帳號池計數每 30 秒以唯讀方式更新。所有帳號被限流時，狀態會顯示依資料庫鎖定時間計算的下次嘗試時間（香港時間）；不會清除限流鎖。有效帳號恢復可用後，等待中的回補會自動續跑。

## 歷史任務與故障恢復

白名單使用者可為自己的訂閱啟動回補。相同目標且已涵蓋申請日期的進行中任務會共用；其他日期範圍與目標排隊，全系統只執行一個 Python 回補。日期範圍在入列時固定，中斷後不會悄悄延長。

回補先以時間軸及日期分窗搜尋保存 metadata，再交由 Node 共用下載佇列封存媒體。回補只發開始、異常及結果通知；進度可從 `/status` 查看，不逐篇傳送歷史貼文。媒體仍待下載時不宣告封存完成。若來源缺少有效建立日期，狀態會顯示需要起日，改用 `/xhistory` 的日期版本即可。

FxTwitter 抓取失敗時依帳號退避重試並通知。恢復後，以及從保存的最後成功時間偵測到長時間停機後，會建立安靜的缺口回補；恢復快照不逐篇補發通知。無法取得的媒體保留待重試並回報異常，不會以空紀錄覆蓋下載歷史。

「搜尋流程完成」不代表歷史完整無缺。搜尋不可見、刪除、受保護、API 缺頁及歷史轉發等情況可能無法補齊；仍有失敗或可疑區段會標示部分完成。Python 舊格式若已將圖片／影片分組且遺失原始交錯順序，無法可靠還原該順序。

## 檔案與備份

```text
downloads/x/alice/
  posts/<貼文ID>.json       # 日常／回補共用的原始資料及本機 manifest
  posts/<貼文ID>.txt
  media/<來源ID>_<序號>.jpg # 共用媒體；影片為 mp4
  alice_archive.sqlite     # Python 歷史 metadata 與搜尋 checkpoint
  alice_posts.jsonl        # Python 歷史匯出
  alice_summary.json
  alice_media_urls.txt
  media_manifest.json
  extract.md
```

圖片使用序號 1 起算，影片／GIF 從 1001 起算，以來源貼文 ID 與同類媒體序號識別，避免不同來源的圖片／影片分組方式造成檔案碰撞。日常資料即時寫入 `posts/`；SQLite／JSONL／Markdown 是歷史作業的匯出，並非日常資料的即時資料庫。

`data/watch/x/worker.json` 與 `.required` 保護基準、去重、待下載及回補佇列；`data/watch/x/jobs/` 保存請求狀態，`events/` 保存待傳事件。`data/control/x-delivery.json` 與 `.required` 保存每位使用者的文字與相簿收據。與 `data/control/settings.json`、帳號池及下載目錄一起私密備份，請勿刪除這些狀態檔來重試通知。事件及收據目前沒有自動過期清理。

原始 n8n JSON 含有部署憑證，已排除於 Git 與 Docker 建置內容之外；新程式不讀取或沿用其中的 token。

## 本機驗證

```sh
npm test
python3 -m unittest discover -s test -p test_x_history.py
./igctl config --quiet
```

離線測試使用固定回應驗證權限、基準、佇列、媒體與傳送收據；它們不代表真實 FxTwitter／X API 或你的登入 session 已通過線上驗證。
