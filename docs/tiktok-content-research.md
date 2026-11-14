# TikTok 帳號內容監控研究

研究日期：2026-11-14。範圍為擴充目前 LIVE-only 整合，讓同一 Telegram 訂閱也能封存貼文、轉發與 Story。
本文件是第一手文件／原始碼研究與架構建議；**沒有實測登入、抓取目標帳號、下載 Story 或變更現有服務**。upstream 分支會變動，開發前應固定版本或 commit，再用本機 Cookie 做唯讀整合驗證。gallery-dl 的 v1.32.19 release 通知主要開發已移至 Codeberg；本次程式碼分析以仍可讀取的 GitHub 鏡像為依據，不宣稱它等於 Codeberg 最新版本。[遷移公告](https://github.com/mikf/gallery-dl/releases/tag/v1.32.19)、[目前主要來源](https://codeberg.org/mikf/gallery-dl)（Codeberg 原始碼本輪未直接核對）。

## 建議結論

優先以 **gallery-dl 作為內容擷取 adapter**，保留現有 TikTok LIVE worker；Node Telegram 服務繼續獨占設定寫入與 bot polling。獨立的 Python catalog worker 經現有 VPN 讀取訂閱、擷取及封存，透過磁碟事件佇列通知 Node。
先落實影片／相片貼文、轉發、Story、公開個人資料變更，再把公開 likes 與指定貼文留言列為選用功能。不要把「anything else」承諾為能看見任意帳號所有操作。
這是根據下列功能覆蓋與現有架構作出的設計判斷，尚不是線上可靠性結論。

## 可行功能及界線

| 類型 | 研究結果 | 建議產品行為 |
|---|---|---|
| 影片貼文、相片輪播 | gallery-dl 有單篇、帳號 posts 擷取器，並處理 `imagePost` 多圖 | 下載所有可取得媒體，保留原始順序、caption、metadata；照片不要假裝成影片 |
| 轉發 repost | 有專門帳號 reposts 擷取器 | 分開記錄「監控帳號轉發了誰的哪篇」，下載的原作媒體可共用 |
| Story | 有 stories 擷取器；官方說明有效期為 24 小時 | 高頻檢查並優先下載；過期／刪除後不承諾可補回 |
| Duet／Stitch | 官方定義是使用者建立並發布的合拍／拼接影片 | 當作該帳號的新貼文封存；不自動推論能枚舉所有其他人對該帳號的合拍 |
| 暱稱、簡介、頭像、username | TikTokApi `user.info()` 提供帳號資料；gallery-dl 有 avatar 擷取器 | 用穩定 user ID／secUid 維持身份，差異快照另存，不因改名建立第二份歷史 |
| Likes | TikTokApi 支援公開 liked；TikTok 允許使用者控制可見性 | 預設關閉；僅處理目前 session 可見的列表，私密／未授權顯示限制 |
| Saved／收藏 | gallery-dl 有 saved 擷取器，但存在方法不代表可取得任意第三方收藏 | 不列入第一階段承諾；必須另驗證登入身份及實際可見範圍 |
| 留言／回覆 | 官方 Research API 可按 video ID 或 comment ID 查詢 | 可選擇追蹤指定貼文的留言；不承諾列出帳號在全 TikTok 留過的所有留言 |
| 純文字貼文 | TikTok 官方確認此內容格式存在；本次檢查未找到三個候選工具的專用文字貼文擷取保證 | 保留未知 item 的 metadata，標示 unsupported，驗證專用 fixture 後再宣告支援 |
| 私密內容、草稿、私訊、不可見互動 | 不能由公開列表與現有 session 推得可讀取權限 | 不列入帳號公開內容監控的承諾 |

工具能力依據：[gallery-dl 官方設定](https://gdl-org.github.io/docs/configuration.html#extractor-tiktok-user-include)、[TikTok extractor 原始碼](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/tiktok.py)、[TikTokApi user 原始碼](https://github.com/davidteather/TikTok-Api/blob/main/TikTokApi/api/user.py)。
平台格式與可見性依據：[Story](https://support.tiktok.com/en/using-tiktok/creating-videos/tiktok-stories)、[Duet](https://support.tiktok.com/en/using-tiktok/creating-videos/duets-settings)、[Stitch](https://support.tiktok.com/en/using-tiktok/creating-videos/stitch)、[Likes 可見性](https://support.tiktok.com/en/using-tiktok/exploring-videos/liking)、[文字貼文](https://newsroom.tiktok.com/text-posts?lang=en)、[指定影片留言查詢](https://developers.tiktok.com/docs/en/research-api-specs-query-video-comments)。

## 工具取捨

### gallery-dl：優先試驗

官方設定的 `extractor.tiktok.user.include` 支援 avatar、posts、reposts、stories、likes、saved；預設僅 avatar／posts，因此不能直接使用預設值當作全帳號監控。[設定來源](https://gdl-org.github.io/docs/configuration.html#extractor-tiktok-user-include)

原始碼可見 `repost/item_list`、`story/item_list`、相片與影片分流及分頁處理。它也有登入、地區限制及未知狀態碼處理，部分錯誤會記錄後繼續；因此 adapter 必須保存成功／部分失敗狀態，**不能把零筆輸出當成成功的空帳號**，也不能只憑 process exit code 判定完整成功；必須保留 pagination／status 檢查和結構化錯誤訊號。這是原始碼檢查，並非已用本 repo Cookie 驗證。原始碼標示 GPLv2；建議固定外部工具版本並以程序邊界整合，若重新分發則保留其授權資訊。[原始碼與授權標頭](https://github.com/mikf/gallery-dl/blob/master/gallery_dl/extractor/tiktok.py)

### TikTokApi：資料與瀏覽器 adapter 的候補

`User.info()`、`videos()`、`liked()`、`playlists()` 已有實作；公開 likes 有清楚的可見性限制。本次檢查的 `User` 介面沒有對等 stories／reposts 方法，因此不建議單靠這套套件完成第一階段。[User 原始碼](https://github.com/davidteather/TikTok-Api/blob/main/TikTokApi/api/user.py)

套件需要 Playwright，維護者也說 TikTok 變動會反覆造成相似問題；應視為非官方、需固定版本和回歸測試的來源，不等同有穩定 SLA 的 API。[專案 README](https://github.com/davidteather/TikTok-Api)

### yt-dlp：影片下載候補，不作唯一帳號監控入口

目前原始碼有單片與帳號影片清單，也處理需登入、IP blocked、重複分頁等情況。`repost_count` 是統計數值，不能替代「這個帳號轉發了哪些作品」的列表。本次原始碼檢查沒有找到專用 Story／帳號 reposts 擷取器；相片輪播應由已確認處理多圖的工具負責。[TikTok extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py)

### 官方 API：不能直接代替任意帳號監控

Display API 提供 profile 與影片 metadata；其登入模型要求使用者授權 app，因此不適合作為任意輸入第三方 username 的通用來源。[Display API](https://developers.tiktok.com/docs/en/display-api-overview)、[Login Kit](https://developers.tiktok.com/docs/en/login-kit-overview)

Research API 的確有 repost、likes、followers、following 等資料，但要符合研究資格、地區／機構要求並經核准，不能假設目前自架 bot 可直接取得權限。[申請資格](https://developers.tiktok.com/products/research-api/)
官方 repost endpoint 支援分頁；回傳的 `create_time` 是原作品發布時間，並非轉發動作時間。資料可能因刪除、私密化或內容管理而少於要求筆數，不能以少於 page size 判斷已完成。[Reposted videos API](https://developers.tiktok.com/docs/en/research-api-specs-query-user-reposted-videos)

## 接入目前 repo 的方案（設計建議）

現有 `src/tiktok-settings.mjs` 只有 `start`／`video` 兩個通知種類；`tiktok/worker.py` 負責 LIVE 錄製，`src/tiktok-delivery.mjs` 僅允許 `live/` 下的 MP4。
因此增加內容功能需要完整的 catalog 狀態與傳送路徑，不能只把更多 URL 交給目前 LIVE uploader。

建議拆分：

1. 保留 LIVE worker。新增獨立 Python catalog worker，以現有 VPN、唯讀 Cookie、唯讀 Telegram 設定執行擷取；避免歷史掃描卡住開播檢查與錄影。
2. 訂閱仍共用 `tiktokTargets`，新增 `post`／`repost`／`story`／`profile` 類型；既有訂閱透過明確 schema migration 補上設定，不刪除 `start`／`video` 與既有 generation。
3. 把 provider 結果轉成自己的穩定模型，包含 target ID、author ID、item ID、kind、publishedAt、observedAt、ordered assets、cursor、complete、errors。不要讓 gallery-dl 的內部欄位直接成為永久狀態格式。
4. 每個帳號、每個類型獨立 baseline、cursor、退避與重試。第一次成功掃描的貼文／轉發安靜封存；新內容才通知。Story 建議沿用 IG：加入當下仍可取得的 Story 可通知。此為產品建議，尚待確認。
5. Story 建議每 1–2 分鐘、貼文／轉發每 5 分鐘、profile 每 30 分鐘；帶隨機延遲與限流退避。這些是起始工程設定，不是 TikTok 官方允許速率。
6. 下載與通知分開持久化。共享目標只抓一次，各使用者以 generation、joinedAt、通知 since 與獨立 receipt 決定是否傳送。關通知繼續封存；重新開啟不回放已略過期間內容。
7. Repost 去重鍵使用 `(target ID, original item ID, kind)`，媒體鍵使用原作 item ID／asset index。A、B 都轉發同一作品時，保留兩個活動事件，但共用媒體。顯示原作者與轉發帳號；沒有可信 repost timestamp 時只寫首次偵測時間。
8. 先下載至 `.part`，驗證檔案格式、大小與 CDN／redirect，再原子 rename；caption／metadata 與媒體 manifest 一併保存。過期 CDN URL 要重新取得，不能永久當作下載身份。
9. 使用共用 Local Bot API 傳照片、影片與相簿，超長 caption 另發文字；沿用待傳佇列、收據與不確定結果處理。大影片沿用分段策略；大檔上傳不阻塞 Story／開播通知。
10. 回應不完整、登入過期、captcha、限流、未知 item、重複 cursor 都要顯示限制／失敗；不清空歷史、不誤報「沒有內容」。刪除或不可見不自動刪除本機封存，也不因單次缺席立即宣告刪除。

建議目錄：

```text
downloads/tiktok/<穩定帳號資料夾>/
  live/
  posts/<item ID>/metadata.json, caption.txt, 01.mp4 或 01.jpg...
  stories/<item ID>/metadata.json, 01.jpg 或 01.mp4...
  reposts/<original item ID>.json       # 活動 metadata，指向共用原作媒體
  profile/<偵測時間>/profile.json, avatar.jpg
```

可另外提供歷史回補；先保存 cursor／checkpoint，UI 明確區分「掃描進度」和「媒體封存完成」。Story 不能靠歷史回補復原已失效內容。

## 實作前必做的最小驗證

用同一 VPN 與登入 Cookie，對一個已知有內容的帳號做隔離的唯讀 proof of concept，至少驗證：影片、照片輪播、轉發及當前 Story 四種。每種對照網頁可見筆數與分頁，記錄來源版本、取回時間、成功／限制／失敗，且不保存 Cookie／signed URL 至測試 fixture 或公開日誌。

Story 需特別檢查是否產生觀看紀錄。官方說作者能查看 Story 觀看者；未驗證之前，不能假設 IG read guard 的行為能直接套用到 TikTok，亦不能宣稱匿名。[Story 觀看紀錄說明](https://support.tiktok.com/en/using-tiktok/creating-videos/tiktok-stories)

離線 fixture 至少涵蓋：空帳號 vs 失敗、登入限定、403／429、分頁重複／中斷、照片混合順序、跨目標同一 repost、首次 baseline、重新訂閱、關通知、重啟去重、Story 過期、改名、字幕／音樂可選、未知純文字 item。

若四種實測通過，再接入正式 worker／Telegram；若 Story 只在特定登入或頁面流程可用，應先以「實驗性／受限」呈現，避免整個帳號監控被判成正常。
