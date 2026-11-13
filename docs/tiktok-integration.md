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
