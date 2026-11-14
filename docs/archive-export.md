# 封存匯出

在 Telegram 的 Instagram／X／TikTok **帳號選單**按「📦 匯出全部封存」，先查看檔案數、估算大小及已知缺失，再按「確認匯出」。每次只選一個平台的一個帳號，包含所有既有歷史，不提供日期篩選。

一般白名單使用者只能匯出目前訂閱的帳號，包含訂閱前的封存；管理員可從主選單的「管理員封存匯出」選擇其他已有封存的帳號。通知開關不影響匯出權限。取消訂閱、重新訂閱的新 generation、移除白名單或取消匯出，都會使該申請者舊連結失效；其他申請者不受影響。

管理員選擇平台後直接顯示帳號清單，不排入背景匯出佇列或先發送等待訊息。背景匯出結果的配送也獨立於 Telegram 收訊輪詢，不需等下一則訊息或長輪詢結束。

## 匯出內容與生命週期

- 一個可獨立解壓的 ZIP，使用 ZIP64 支援超過 4 GiB 的檔案／封存。媒體原樣保存、不轉碼，使用 ZIP_STORED 避免重複壓縮。
- 自動監控保存的圖片／影片、caption／貼文文字，以及安全挑選的來源與時間資料 `export-manifest.json`。TikTok 包含已完成的 LIVE MP4；排除正在錄製／轉檔的檔案及重複傳送用分段（完整原檔仍在時）。
- 排除手動下載快取、`.part`、登入憑證、cookies、SQLite、內部狀態與含 CDN 網址的原始 metadata。
- 開始打包時建立檔案清單；監控不中斷。新下載／改動的檔案不併入既有快照。這是檔案清單快照，不是檔案系統的原子快照；打包期間改動、遺失或無法讀取的檔案會列入缺失，無法安全完成時回報失敗。
- 缺失時仍匯出可讀檔案，在 Bot 標示「封存不完整」，並附 `缺失清單.txt`。這不代表來源平台所有歷史都已抓完；只處理當時本機封存。
- 同一帳號已有未到期 ZIP 時重用，顯示原快照時間，不延長到期時間。每位申請者的 token 獨立，取消其中一人不撤銷其他人的連結。
- 完成後有效 **24 小時**。網址持有者即可下載，允許轉傳，沒有瀏覽器 Telegram 登入驗證。支援 GET／HEAD、單段 HTTP Range 及 ETag 續傳。
- 到期後禁止新下載及重新連線續傳；已開始的傳輸繼續到完成或連線中斷。活動連線歸零後清除暫存 ZIP；不刪原始封存。
- 全系統一次打包一份，每人最多一個未完成申請。同帳號共用工作。按「匯出狀態」可查看排隊／處理檔案數，完成後重新取得同期限的連結。
- 可取消自己的申請；沒有其他等待者時停止工作。重啟後，排隊申請保留，中斷的 ZIP 從頭建立，已完成 ZIP／token 保留原期限。
- 開始前需有約「來源總大小＋ZIP／manifest 開銷＋1 GiB 保留空間」，打包期間也檢查保留空間。不足時拒絕／停止工作，不刪其他有效 ZIP 或原始封存。

## Docker 部署：Mac 與 NAS

`igctl` 已包含 `compose.export.yml`；新增服務預設透過 profile 關閉。Docker Desktop 的 Mac 與支援 Docker Compose v2 的 Linux NAS 使用同一套設定，不依賴主機 Python 或 Node。

在 `.env` 設定：

```dotenv
ARCHIVE_EXPORT_ENABLED=1
ARCHIVE_EXPORT_BASE_URL=https://download.eddieli1130.dpdns.org
# 可改為 NAS 的絕對路徑；下載與匯出空間都必須足夠。
IG_EXPORT_DIR=./data/exports
CLOUDFLARE_TUNNEL_TOKEN_FILE=./data/cloudflare/tunnel-token
```

下載原檔、watch 狀態、controller 設定對 `archive-export` 都是唯讀；只有 `/exports` 可寫。Telegram controller 對 `/exports` 唯讀，仍是 `settings.json` 唯一寫入者。匯出服務不持有 Bot token 或登入 cookies。

```sh
./igctl --profile archive-export build archive-export
./igctl --profile archive-export up -d --no-deps archive-export
```

### Cloudflare Tunnel

採官方 remotely-managed Tunnel。操作方式依據 [Cloudflare Docker 部署](https://developers.cloudflare.com/tunnel/get-started/) 與 [token-file 設定](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/)。

1. 在 Cloudflare 帳戶的 Networking → Tunnels 建立專用 tunnel；目前 Mac 部署使用 `social-media-stalker`。
2. 將 tunnel token 以單行文字保存到 `data/cloudflare/tunnel-token`，目錄權限 `0700`、檔案 `0600`。不要貼入聊天、命令參數、Git 或文件。容器以 token-file 讀取；不要分享此 token。
3. 新增公開 hostname `download.eddieli1130.dpdns.org`，origin service 設為 **`http://archive-export:8090`**，讓 dashboard 建立對應的 proxied CNAME。其餘路由維持 404。
4. 此 hostname 的 `/files/*` 設定 **Bypass cache**；不要套用 Cache Everything、Edge TTL 或會覆寫 `no-store` 的規則。不要額外記錄完整下載 URL／token，也不要把 `/downloads` 或 `/exports` 設成靜態公開目錄。
5. 啟動 tunnel 並重新建立 Telegram controller，以掛載匯出狀態與啟用選單：

```sh
./igctl --profile archive-export --profile archive-tunnel up -d --no-deps archive-tunnel ig-telegram
./igctl --profile archive-export --profile archive-tunnel ps archive-export archive-tunnel ig-telegram
```

匯出容器不映射任何主機埠，只有同 Docker network 的 `cloudflared` 存取 HTTP 8090；外部使用 Cloudflare 提供的 HTTPS。沒有路由器入站開埠。HTTP 服務只接受 `/files/<43字元隨機token>`，不提供瀏覽／管理介面。

Tunnel 容器使用 `fatal` 日誌級別，避免一般請求錯誤把 token URL 帶入日誌；不要在正式下載期間開啟 debug。連線狀態可從 Cloudflare Dashboard 的 connector health 查看。

Docker 內部另有 `http://archive-tunnel:2000/ready` 健康端點，未映射至主機，也不在公開 hostname 的路由內。

**Mac 與 NAS 切換：**可以在任一端部署，但同一下載 hostname 不要同時連到兩套不同儲存的服務，否則請求可能落到沒有該 ZIP 的主機。移轉時先停止舊服務，私下複製完整封存、watch／control 狀態、匯出狀態及仍有效 ZIP，再啟動另一端；同一 Bot／匯出資料目錄各自只允許一個 writer。若要兩端獨立同時使用，配置不同 hostname／tunnel，並使用各自的 Bot／狀態。

### 驗證

```sh
npm test
npm run test:export
./igctl --profile archive-export --profile archive-tunnel config --quiet
```

正式對外驗收需在 Telegram 申請一個實際帳號：確認 ZIP 可解壓且沒有憑證、HTTP HEAD 大小正確、Range 續傳有效，並實測超過 4 GiB／LIVE 封存的速度與長時間連線。Cloudflare Tunnel 並不保證家用上傳速度，實際下載仍受主機、ISP 與路徑影響。不要把 Cloudflare 的上傳／快取大小限制誤當下載單檔大小限制。

### 運行狀態與停用

`data/exports/health.json` 是 worker 心跳，`state.json` 保存申請、token hashes、待交付回覆與工作；待交付回覆可能含完整 token 連結，因此整個目錄都屬私人資料。`reports.json` 供 controller 讀取並以 `exportReceipts` 在同一設定交易確認交付。ZIP 檔名為內部隨機工作 ID。

損壞／缺失的設定不授予下載權限；有 `.required` 而遺失匯出狀態時拒絕啟動。匯出回覆讀取失敗不會停止其他平台的 Telegram 工作。檔案路徑以 directory descriptors 及 `O_NOFOLLOW` 開啟，拒絕路徑穿越、symlink 與跨帳號路徑。最多同時處理八個 HTTP 連線，每個連線的 socket timeout 為 60 秒；持續有資料傳輸可以更久。

停用時先設 `ARCHIVE_EXPORT_ENABLED=0`、重新建立 `ig-telegram`，再停止 `archive-tunnel archive-export`。不要刪除原始封存來清理匯出；移除暫存狀態前需停止匯出服務並確認沒有使用中的連結。
