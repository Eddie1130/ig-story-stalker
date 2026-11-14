# TikTok LIVE 與 Telegram Local Bot API 整合

## 行為

Telegram 私人選單新增 **TikTok LIVE**；沿用現有白名單及私人聊天身份驗證。
`/ttadd alice` 新增個人訂閱，選單可移除及獨立切換「開播通知」與「完成後傳送影片」。兩項預設開啟，關閉只影響通知，本機錄影繼續。
預設沒有 TikTok 訂閱，請透過 Telegram 新增帳號。若明確設定 `TIKTOK_TARGET_USERNAMES`，只在初次啟用時匯入擁有者；之後環境設定不會覆寫已儲存選擇。
多人訂閱同帳號只錄一次。所有開播帳號同時錄製，**沒有並行錄影場數上限**；網路、磁碟、檔案描述元與記憶體仍是實際容量限制。瀏覽器解析串行，MP4 轉檔及分段使用獨立序列佇列。
最後一人退訂後，正在錄製的場次完成後停止監控；既有檔案不刪除。已退訂或撤銷白名單者不會收到待傳通知。

錄影存放於：

```text
downloads/tiktok/<帳號>/live/<錄影開始時間>_JST_<直播ID>.mp4
```

時間是本機偵測並開始錄影的 JST 時間，不保證等於實際開播時間。完整 MP4 保留，超過 1900 MB 時額外以 FFmpeg stream copy 分段並實測檔案大小；如果關鍵影格分佈導致仍過大，縮短分段時間重試，不重新編碼。不能安全分段時保留原檔並回報。
本機與 Telegram 狀態分開保存；影片不因上傳失敗而刪除。傳送結果不確定時通知並停止自動重送，避免重複影片。
新加入訂閱者不會補送已經開始錄影場次的通知或影片。

## 私密設定

`.env.tiktok` 保存 Surfshark OpenVPN service 憑證及 Local Bot API 的 `TELEGRAM_API_ID`／`TELEGRAM_API_HASH`，範本為 `.env.tiktok.example`。
TikTok Cookie 保存在 `data/tiktok/cookies.json`，支援名稱到值的 object；匯入時也支援 Chrome array。
這些檔案不會加入 Git 或 Docker build context。VPN 及 Local API 私密設定檔使用 0600，Cookie 目錄使用 0700。
既有 `.env.telegram` 的 bot token 保持作為三平台共用 bot，不另外建立 TikTok poller。
TikTok worker／resolver 共用 Gluetun 網路，VPN 斷線時由 Gluetun 防止流量直接外洩。
IG／X 不經這個 VPN。Local Bot API 透過內部 Compose 網路存取，沒有對外公布連接埠，並以唯讀方式掛載 `/downloads`。

## 首次切換既有 Telegram bot

先確認沒有其他部署仍在使用同一個 bot；來源 TikTok 專案如有使用同一個 token，應在直播及上傳完成後停用來源服務。
來源的 Cookie/profile 只讀取，不修改；來源容器不會由本 repo 自動停止。
已有錄影進行時，應等錄影完成再切換。不要執行 `down -v`。

在本 repo 執行：

```sh
./igctl config --quiet
./igctl build ig-watch ig-watchdog ig-telegram tiktok-watch tiktok-browser-resolver
# 暫停會使用 bot 的現有服務，再對 Telegram 雲端登出一次。
./igctl stop ig-watch ig-watchdog ig-telegram
node scripts/migrate-telegram-local.mjs
# 僅在登出成功後繼續。
./igctl up -d telegram-bot-api tiktok-vpn tiktok-browser-resolver tiktok-watch ig-telegram ig-watch ig-watchdog x-watch
./igctl ps
```

`logOut` 只切換 bot API 登入位置，不刪除訊息或待處理更新。依 Telegram 規則，雲端登出後短時間內不能立即切回雲端。
不要在未確認登出成功時同時啟動兩個 poller。
所有平台及 watchdog 改用 `TELEGRAM_BOT_API_URL=http://telegram-bot-api:8081`；單檔上限 2000 MB。
IG／X 本機媒體上傳保留原有傳送方式，允許 Local API 大檔上限；TikTok 直接使用共用磁碟的 `file://` 路徑，避免將整部影片讀入 Node 記憶體。

## 狀態及恢復

`/status` 顯示自己 TikTok 訂閱的錄影／監控狀態及 worker 心跳。
`data/watch/tiktok/captures/` 在下載前保存正在錄影的 metadata；`processing/` 保存待轉檔／分段工作；`events/` 保存待傳事件。
`data/control/tiktok/x-delivery.json` 保存每位使用者的傳送收據（沿用既有傳送引擎及歷史保護 marker）。
這些狀態、設定及下載檔案應一起備份。不要刪除狀態檔來重試。
正常停止會嘗試完成現有緩衝寫入；強制停止後，重啟會嘗試轉檔保留的原始片段，並通知中斷。不完整或無法解析的來源會保留待檢查。
無法在停機期間補錄直播，也不保證失效的 Cookie 可存取需要登入的直播。

## 驗證及限制

```sh
npm test
python3 -m unittest discover -s test -p test_tiktok.py -v
python3 -m compileall -q tiktok
./igctl config --quiet
```

worker 基於來源 `/Users/eddie/Project/TikTok-Recorder` 的 API／錄影 loop 及 Browser Resolver，並保留 native API → TikRec／browser fallback 和直播正常結束的再次確認。
上游來源：https://github.com/Michele0303/tiktok-live-recorder ，MIT 授權見 `tiktok/LICENSE`。
來源 `develop` runtime 固定至建置驗證的 digest；目前只提供 amd64，因此 Compose 明確指定 `linux/amd64`，ARM Docker 主機需要模擬支援。Browser Resolver 由 Playwright 建置。
離線測試包含真實本機 FFmpeg 轉檔／分段，沒有證明實際 TikTok 直播、來源登入資料、Surfshark 或 Telegram 大檔上傳可用；部署後仍需實際直播驗證。

回復時先停止 TikTok worker 並保留其原始檔、工作及下載；不要刪除 volumes。如要改回雲端 Bot API，先遵照 Telegram Local server `logOut` 流程及等待限制，再調整三平台與 watchdog 的 endpoint，避免兩邊同時操作同一 bot。

## 帳號內容監控（貼文／轉發／Story／個人資料）

新增的 `tiktok-catalog` 與 LIVE worker 分開執行，共用同一 VPN 及唯讀 Cookie。
Telegram 的 TikTok 帳號選單現在分別控制貼文／照片、轉發、Story、個人資料變更；公開讚好清單為選用，預設關閉。
既有 LIVE 通知設定與 subscription generation 保留；新類型在控制服務啟動時遷移，既有選擇不會重設。

首次貼文／轉發掃描逐頁建立基準並安靜封存；基準未完成前不通知舊內容。Story 在加入時仍可讀取便可通知；新加入者不會重送給原有訂閱者。
再次啟用通知不回放略過期間的內容。轉發以目標帳號和原作 ID 記錄活動，下載媒體以原作 ID 共用；原作日期不會被冒充成轉發日期。
文字修改會更新封存 caption，不重送媒體。改名時保留原有數字 user ID 的資料夾；訂閱仍以你輸入的名稱進行查詢，若舊名稱不再可解析，需要在 Telegram 改訂閱新名稱。
個人資料每次變更都保存新快照，包括 A→B→A 的回復。私密讚好、收藏、全站留言及未支援的純文字 item 不承諾可取得；未知格式會顯示失敗，保留進度。

媒體位於 `downloads/tiktok/<帳號資料夾>/posts|reposts|stories|profile|likes/<ID>/`，附 `metadata.json`、`caption.txt`。
原作媒體存放於 `downloads/tiktok/<帳號>/media/<原作ID>/`；跨帳號相同原作使用 hard link 共用磁碟內容。既有 posts／reposts 等分類路徑保留相容連結；保留完整影片，超大影片另外產生 `_parts/`。
啟動時會將舊的 `downloads/tiktok/media/` 遷移至各帳號，先驗證並建立所有連結才移除舊連結；中斷後可重試，完成狀態記錄於 catalog 的 `media-layout.json`。舊帳號若名為 `media`，會於變更前停止並回報 `TIKTOK_MEDIA_LAYOUT_RESERVED_ACCOUNT`，避免路徑衝突。
待抓／待下載、基準及通知 outbox 保存於 `data/watch/tiktok/catalog/catalog.sqlite`，旁邊的 `.required` marker 不可刪除。需備份時停止 catalog 或使用 SQLite backup，不要只複製正在寫入的主檔。

起始檢查間隔：Story 120 秒、貼文／轉發 300 秒、profile 1800 秒、選用 likes 600 秒；限流／失敗會退避，實際時間也受帳號數與下載負載影響。
這是工程預設，不代表 TikTok 官方允許速率。所有類型分開保存錯誤與基準，單一類型失敗不會清空其他歷史。

### 啟用方式

先等現有錄影／上傳完成；此版本替 VPN 增加本機 noVNC port，Compose 可能需要重建 VPN 容器，不能在直播錄影途中切換。

```sh
./igctl config --quiet
./igctl build tiktok-catalog ig-telegram
./igctl up -d tiktok-vpn tiktok-browser-resolver tiktok-watch tiktok-catalog ig-telegram
./igctl ps
```

`/status` 會分開顯示 LIVE 與 catalog 各類型狀態。初始訂閱仍為空；已經儲存的訂閱不受影響。

### HTTP 403／CAPTCHA／登入處理

2026-11-14 隔離測試：同一 VPN 與唯讀 Cookie 下，HTTP 擷取失敗；獨立 Chromium 讀取 `mikurun33` 個人頁仍收到 **HTTP 403**。
這不是成功的空列表，也不足以斷言就是 CAPTCHA。之後改用一般 Chromium 人工登入並保存 session，已成功驗證個人資料、20 筆貼文、20 筆轉發與後續分頁；Story API 明確回覆成功、總數為零且無前後頁，現已正確辨識空 Story。尚未用有效中的 Story 或真實照片輪播做端到端驗證。
若再次被拒絕，程式會回報 `TIKTOK_BROWSER_HTTP_403`，遇到可識別的驗證畫面會回報 `TIKTOK_CAPTCHA_REQUIRED`，不清空狀態或聲稱沒有新內容。
未啟用或購買任何第三方 CAPTCHA solver。

需要人工登入／完成驗證時：

```sh
# 與 catalog 共用 profile，先停止 catalog；LIVE worker 不必停止。
./igctl stop tiktok-catalog
./igctl --profile tiktok-login build tiktok-login
./igctl --profile tiktok-login run --rm tiktok-login
```

開啟 `http://127.0.0.1:6081/vnc.html`，使用 `.env` 的 `VNC_PASSWORD`（至少八字元），在正常 TikTok 頁面登入或完成要求的驗證。
遠端 NAS 請使用 SSH tunnel：`ssh -L 6081:127.0.0.1:6081 user@nas`。此 noVNC port 預設只綁定主機 loopback。
完成後 Ctrl-C，等待登入容器退出，才執行 `./igctl up -d tiktok-catalog`，避免兩個 Chromium 同時開啟 profile。
第一次使用新 port 前，需要先在沒有錄影時完成上面的 VPN recreate 步驟。
登入結果保存在獨立 `tiktok-catalog-profile` volume；不寫入 Git、日誌或既有 LIVE browser profile。
更換 Cookie 檔內容時會重新匯入，否則保留瀏覽器已更新的 session。
人工登入現在直接啟動一般 Chromium，不使用 Playwright 自動化啟動旗標；自動讀取也沿用普通 Chromium 的原始持久 context，Playwright 僅透過 loopback CDP 連線讀取；不再為每種類型反覆建立 headless／incognito session。
自動模式封鎖 Service Worker、WebSocket 與非 GET／不在 allowlist 的 TikTok API；人工登入模式允許正常登入／驗證操作。未宣稱 Story 讀取匿名。
人工驗證後若仍是 403，應檢查 VPN 出口與帳號可見性；不要當成已解決或無限快速重試。

### 本次驗證

除了原有測試，新增 provider 嚴格空結果／失敗判定、分頁 checkpoint、首次靜默基準、Story 新訂閱 generation、轉發共用媒體、caption 編輯、profile 回復變更、過期 URL 更新、設定遷移、照片大小／尺寸、相簿順序，以及通知 lane 不被影片佇列阻塞的測試。

```sh
npm test
python3 -m unittest discover -s test -p 'test_*.py'
ruff check tiktok/catalog*.py test/test_tiktok_catalog.py
./igctl config --quiet
```


### 登入後實測修正

- 有已保存 profile 時優先以登入瀏覽器讀取，失敗才回退 HTTP。
- WebSocket 採不連接遠端的路由，避免同步 close callback 令瀏覽器卡住。
- 空 Story 僅在兩個 status 皆明確成功、TotalCount=0、前後分頁旗標皆 false 時接受；缺失／矛盾回應仍視為失敗。
- 影片保留已驗證主機的多個 CDN 候選，並沿用瀏覽器 User-Agent／Referer；下載不轉送 Cookie。已實際下載並驗證一段 807541 bytes 的 MP4。

- 正式輪詢會重用同一個普通 Chromium／原始登入 context；不同內容類型與帳號共用工作階段，歷史分頁間隔至少 30 秒。
- 在導航前 bypass／停止現有 TikTok Service Worker、取消其註冊並禁止新註冊，再套用 GET／API allowlist 和不連外的 WebSocket 路由。沒有匿名觀看保證。
- 若出現 CAPTCHA，session 鎖定後不再送出額外瀏覽請求，健康狀態明確標示需要人工驗證。關閉／崩潰的瀏覽器則會清理並於重試時重建。

### 正式啟用驗證結果

使用者完成登入後，已切換為長駐普通 Chromium 的原始持久 context，正式 `tiktok-catalog` 已啟動。
檢查當時 `mikurun33`／`maidcafe_ikiss` 的 Story、貼文、轉發與 profile 四類錯誤計數皆為零；貼文／轉發正在分頁建立靜默基準。
磁碟已有 6 部正式封存 MP4，另有 116 筆待處理；首部影片經 ffprobe 確認為 H.264、720×1280、約 15 秒。
這些是啟用當下快照，數字會隨封存進度改變。尚未宣稱已驗證有效中的 Story 或照片輪播下載，且未保證未來不會再次要求人工驗證。
啟用只更新內容 worker；VPN／LIVE 容器 ID 與啟動時間維持不變。人工登入容器已停止，避免與 reader 同時使用 profile。

### 單筆資料異常與獨立補查

媒體資料不完整但仍有有效 TikTok ID 的項目，會與分頁 checkpoint 一起存入私密 SQLite，狀態為 `unresolved`。
同頁可解析的項目照常入列下載，分頁按原始清單筆數前進；這些待補查項目不會被標成已下載或直接丟棄。
補查透過單篇 ID 重新讀取完整資料，採獨立退避；成功後才進入下載佇列，保留原始偵測時間、訂閱 generation 與收件人，所以舊基準內容仍安靜封存。
已成功封存的項目不會因後續一次缺少媒體資料而被降級。API 整頁失敗、登入驗證、無有效 ID 或損壞分頁格式仍屬查詢錯誤，不會被當作正常空清單。
`/status` 的各類型狀態會附上「N 筆待補查」；服務健康代表輪詢仍運作，不代表所有待補查內容已成功取得。
原始問題 payload 僅保存在權限受限的 runtime SQLite，不寫入公開封存、Telegram 或日誌；補查成功後以正常資料取代。
本次新增同頁混合好壞項目、分頁前進、重啟保留、退避、補查後通知時間／收件人不變及既有封存不降級等回歸測試。

本次正式驗證：原本卡在 cursor 48 的 `maidcafe_ikiss` 轉發已前進到 77，查詢錯誤歸零，catalog 恢復 healthy。
問題項目的實際 video 物件只有封面／長度／尺寸等欄位，沒有播放網址；單篇補查仍無法取得媒體，已獨立保留為 1 筆 unresolved，其他內容正常封存。
部署當下已有 234 筆 ready、813 筆 pending；這是即時進度快照，不是固定總數。80 項 Python 測試與格式／靜態檢查通過。
