# 🌸 妙境法軒 — 典藏課程 Web 平台

一個基於 **Node.js + Next.js App Router + React + TypeScript** 打造的高效能、美觀且功能完備的現代化 Web 瀏覽平台，完整收錄 `fayun.org` 玅境長老一生講述之佛法經論、禪修止觀、戒律與專題開示資料。

包含 684 門課程、音訊 MP3/M4A 線上串流播放、影音影片觀看、以及 1000+ 份 PDF 講義筆記線上對照閱讀。

> 📐 想了解內部結構、資料流與設計取捨，請見 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

---

## ✨ 核心功能特色

### 1. 🈁 繁體中文極簡樹狀目錄 (Collapsible Tree Navigation)
- **四階層清晰歸類**：`主分類 (佛法經論/禪修止觀/開示) ➔ 子目錄 (解經/釋論/止觀...) ➔ 主題 (般若/瑜伽/阿含...) ➔ 課程名稱`。
- **全繁體中文標籤**：所有主題與選單皆映射為標準繁體中文（如 *般若經藏*、*瑜伽師地論*、*攝大乘論*、*八識規矩頌* 等）。
- **連動播放標籤**：背景正在播放音訊的課程會在樹狀目錄旁顯示 **`🔊` 動態播放** 圖示。

### 2. 🔍 高效防抖搜尋與媒體類型過濾 (Debounced Search & Media Pills)
- **即時搜尋**：輸入經論名稱、地點、年份或主題關鍵字，採用 React `useDeferredValue` 防抖機制，打字極速不卡頓。
- **媒體快選標籤**：提供 `[ 全部 ]` `[ 🎙️ 音訊 ]` `[ 🎥 影音 ]` `[ 📚 講義 ]` 按鈕，可秒級過濾出包含指定媒體資源的課程。

### 3. 🔊 全站全域懸浮音訊播放器 (Global Persistent Audio Player)
- **跨頁與跨課程不中斷**：採用全域 `AudioProvider` 狀態管理。切換課程、瀏覽目錄或開啟 PDF 講義時，背景音訊**持續無縫播放**。
- **底部懸浮控制列**：
  - **快進快退**：支援 **`-10s`** 倒退與 **`+10s`** 快進按鈕。
  - **全域鍵盤快捷鍵**：
    - `Space`（空白鍵）：播放 / 暫停
    - `← / →`（左右方向鍵）：倒退 5 秒 / 快進 5 秒
    - `M` 鍵：靜音切換
  - **倍速切換**：`0.75x`, `1.0x`, `1.25x`, `1.5x`, `2.0x`。
  - **播放紀錄記憶**：使用 `localStorage` 自動記憶最後收聽的集數與時間點，下次開網頁自動還原。

### 4. 🎥 影音影片播放與動態互斥暫停 (Video Player & Interlock)
- **影音自動偵測**：支援 `.mp4`, `.m4v`, `.wmv`, `.mov` 等多種影音格式。
- **互斥暫停機制**：點選觀看影片時，系統會**自動將背景音訊暫停**，避免影音與背景音訊聲音重疊。

### 5. 📖 雙欄對照閱讀模式 (Split-Screen View)
- 在桌面上提供 **`📖 雙欄對照閱讀`** 頁籤，讓使用者**左欄點選集數收聽，右欄同步線上對照閱讀 PDF 筆記講義**，無需頻繁切換頁籤。

### 6. ⚡ 後端高速 LRU 快取與串流代理 (`/api/proxy` & `/api/list-files`)
- **Server-Side LRU 快取**：`/api/list-files` 採用 Node.js 快取，重複造訪課程實現 **0ms 瞬間載入**。
- **媒體代理服務**：後端 `/api/proxy` 自動轉發 `fayun.org` MP3/M4A/MP4/PDF 檔案，支援 **HTTP Range Header** 拖曳定位與跨域防護。

### 7. 🔄 手動 Web 連線同步 (`/api/scan`)
- 目錄區設有 **`🔄 手動觸發掃描/同步`** 按鈕；管理員登入後點擊即可連線 `fayun.org` 掃描檢查是否有新上架的經典與媒體資源，並自動更新數據庫。排程腳本可改用 `TASK_API_TOKEN`。

---

## 🛠️ 技術棧 (Tech Stack)

- **前端與框架**：Next.js 16 (App Router), React 19, TypeScript
- **執行環境**：**Node.js 24**（`.nvmrc` / `package.json` `engines` / Dockerfile 三處一致鎖定）
- **狀態管理**：React Context API (`AudioContext`) + LocalStorage
- **視覺與設計**：Vanilla CSS Custom Design System (Modern Zen Aesthetics Theme)
- **後端 API Services**：Next.js Node.js Route Handlers (`/api/courses`, `/api/list-files`, `/api/proxy`, `/api/scan`)
- **媒體處理解析**：Python 3 Data Ingestion Scripts (`scripts/scan_fayun.py`)

---

## 📂 專案結構 (Directory Structure)

```
ui2/
├── public/                       # 靜態資源（圖示、manifest）
├── scripts/
│   ├── build_unified_db.py      # 課程資料庫建置腳本
│   ├── scan_fayun.py            # fayun.org 媒體庫掃描腳本
│   └── admin-password.mjs       # 管理員密碼／TOTP CLI
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── admin/          # 登入、登出、密碼、TOTP、工作階段、網站網址
│   │   │   ├── courses/        # 全站課程索引 API
│   │   │   ├── list-files/     # 遠端目錄查詢 API（附 Server LRU Cache）
│   │   │   ├── proxy/          # 音訊／影片／PDF 串流代理（支援 Range）
│   │   │   ├── scan/           # 媒體掃描同步 API
│   │   │   └── health-check/   # 自我巡檢修復 API
│   │   ├── styles/             # 樣式（由 globals.css 依序 @import）
│   │   │   ├── base.css        #   reset、字級縮放基底
│   │   │   ├── themes.css      #   六套主題的 15 個 CSS 變數
│   │   │   ├── layout.css      #   外殼、側欄、目錄樹、播放列
│   │   │   └── components.css  #   分頁、集數清單、PDF、設定、首頁
│   │   ├── globals.css         # 樣式進入點（僅含 @import）
│   │   ├── layout.tsx          # 根版面、SEO Metadata、viewport
│   │   ├── manifest.ts         # PWA manifest
│   │   └── page.tsx            # 主頁面、樹狀導覽、全站狀態
│   ├── components/
│   │   ├── AdminSecurityPanel.tsx  # 管理員登入／密碼／TOTP 面板
│   │   ├── AudioTab.tsx            # 音訊分頁（搜尋、卷次、分批清單）
│   │   ├── CourseDetail.tsx        # 課程詳細頁與五個分頁
│   │   ├── GlobalAudioPlayer.tsx   # 全站懸浮播放器
│   │   ├── HomePortal.tsx          # 首頁入口、學習法種類、每日推薦
│   │   ├── ListErrorState.tsx      # 清單載入失敗與重試（共用）
│   │   ├── PdfViewer.tsx           # PDF 講義閱讀器
│   │   ├── SettingsModal.tsx       # 設定面板（主題、字級、網站網址）
│   │   ├── SiteUrlPanel.tsx        # 網站網址設定子面板
│   │   ├── TreeNav.tsx             # 樹狀目錄與防抖搜尋
│   │   └── VideoPlayer.tsx         # 影音播放器
│   ├── context/
│   │   └── AudioContext.tsx        # 全域音訊狀態（跨頁不中斷）
│   ├── lib/
│   │   ├── courseMedia.ts          # 純函式：PDF 去重、卷次範圍、排序
│   │   ├── useAudioTracks.ts       # 音訊清單探索（含錯誤狀態）
│   │   ├── useVideoTracks.ts       # 影音清單探索
│   │   ├── usePdfTracks.ts         # 講義清單探索
│   │   ├── playbackStore.ts        # 播放進度、最愛（useSyncExternalStore）
│   │   ├── stringStore.ts          # 型別安全的 localStorage store
│   │   ├── catalog.ts              # 課程資料庫存取
│   │   ├── serverMediaCache.ts     # 媒體快取（LRU、20 GB 上限）
│   │   ├── admin*.ts               # 管理員認證、工作階段、速率限制、稽核
│   │   └── …                       # themePreference、dailyPicks、useServiceWorker 等
│   ├── data/
│   │   └── courses_db.json         # 高速索引課程資料庫
│   ├── types/
│   │   └── course.ts               # TypeScript 型態定義
│   ├── instrumentation.ts          # 啟動時掛載（快取維護）
│   └── proxy.ts                    # 頁面安全標頭（CSP 等）
├── tests/                          # node:test + tsx（449 個斷言案例）
├── data/                           # 執行期資料（DB、快取、日誌、site.json）
├── package.json
└── tsconfig.json
```

---

## 🚀 快速開始 (Getting Started)

### 1. 安裝依賴
```bash
# 需要 Node.js 24（專案已鎖定；nvm 使用者可直接執行 nvm use）
node -v   # 應顯示 v24.x
npm ci
```

### 2. 啟動開發伺服器 (Development Server)
```bash
npm run dev
```
開啟瀏覽器訪問：`http://localhost:8410`

### 3. 編譯生產版本 (Production Build)
```bash
npm run build
npm run start
```

### 4. 驗證 (Verification)
```bash
npm test        # 單元與端點測試（node:test + tsx）
npm run verify  # 全站 5 大維度：測試套件、課程資料庫、媒體快取、行動版配置、生產編譯
npx tsc --noEmit
```

`npm run verify` 會依序執行測試套件、比對 `data/` 與 `src/data/` 兩份課程資料庫
（684 門課程／478 門影音）、檢查 20 GB 媒體快取上限、確認 Next.js `viewport`
匯出與 960px 斷點，最後實際執行一次 `npm run build`。任何一項失敗都會以非 0
結束碼收尾，可直接放進 CI。

管理員相關測試（`tests/admin-*.test.ts`）涵蓋憑證來源優先序與 fail-closed 行為、
CSRF 與來源檢查、工作階段生命週期、速率限制、TOTP、稽核輪替、密碼變更，以及
Phase 2 的 UI 契約（不再保存 `localStorage` 權杖、紀錄檔分級、preload 改 POST）。
它們全部使用 `os.tmpdir()` 下的暫存憑證檔與獨立的 `TASK_LOG_DIR`，不會寫入專案的
`data/`、也不會啟動 `scan_fayun.py`；需要「已被授權」的案例會先植入一個由測試
行程持有的 `scan.lock`，讓請求停在 409 而不是真的觸發掃描。

> 注意：凡是會讀寫媒體快取或任務鎖的測試檔，第一行都必須先匯入
> `./helpers/isolated-media-cache`，讓 `MEDIA_CACHE_DIR` 與 `TASK_LOG_DIR` 指向
> 暫存沙盒；否則會在 `data/logs` 留下 `scan.lock`，被同時執行的開發伺服器誤判為
> 有任務正在跑。純憑證／UI 契約的測試不需要，但仍以 `os.tmpdir()` 建立自己的
> 暫存檔。

---

## 🐳 Docker & GHCR 容器化部署 (GitHub Container Registry)

本專案配置 GitHub Actions CI/CD 工作流，每次更新 `main` 分支均自動編譯並發布 Docker Image 至 GitHub Container Registry。

### 1. 使用 Docker Compose 啟動（推薦，已自帶資料庫與媒體快取持久化）：
```bash
docker compose up -d
```
開啟瀏覽器造訪：`http://localhost:8410`

### 2. 拉取 GHCR 鏡像並以 Docker CLI 運行（務必掛載 `-v $(pwd)/data:/app/data` 持久化目錄）：
```bash
docker pull ghcr.io/jmedzen/ui2:latest
docker run -d -p 8410:8410 -v $(pwd)/data:/app/data --name ui2 ghcr.io/jmedzen/ui2:latest
```

### 3. 本機 Docker 手動編譯與運行：
```bash
docker build -t ui2:latest .
docker run -d -p 8410:8410 -v $(pwd)/data:/app/data --name ui2 ui2:latest
```

> **📌 持久化說明**：掛載 `./data` 目錄可確保資料庫 `data/courses_db.json`（包含所有路徑修正與掃描同步）、`data/media_cache/`（網頁主機媒體快取存檔）以及 `data/logs/` 在更新 Docker 映像時**永久保存**，不被容器刪除。

> **🔧 權限自動修正**：容器啟動時會以 root 短暫執行 `docker-entrypoint.sh`，將 `./data` 的擁有者調整為應用程式使用者（uid 1000 `node`），隨即透過 `su-exec` 降權執行應用程式。因此**不需要**在主機手動 `chown`。若仍看到「資料目錄無法寫入」的錯誤，請確認 `./data/logs` 可寫，且未以 `--user` 指定了無法寫入該目錄的 uid。

> **🩺 任務鎖定（Task Lock）**：`data/logs/scan.lock` 記錄持有任務的 PID。伺服器啟動時會自動清除前一次執行遺留的鎖定，且鎖定僅在持有程序仍存活時才生效，因此 `docker compose restart` 不會再造成「已有任務正在執行中」的永久誤判。

### 映像保留策略

每次建置會把**同一個映像**推到多個 tag（`latest`、`main`、`sha-xxxx`，版號變更時另有 semver tag）。GHCR 為每個 tag 各記一筆 *version*，所以一次建置會產生 3 筆 version。

因此清理邏輯**以「建置」為單位**：依 image digest 把同一次建置的所有 tag 分成一組，保留最新 **5 個建置**，其餘整組刪除。若改用「保留 5 筆 version」，實際只留住約 1.5 次建置，而且會把同一次建置的 tag 拆散（留下 `latest` 卻刪掉對應的 `sha-xxxx`）。

- 自動：每次推送 `main` 後，`docker-publish` 工作流在推送成功後執行清理
- 排程：`Prune Old GHCR Docker Images` 每週日 02:00 UTC 執行一次
- 手動：可在 Actions 頁面觸發該工作流，並指定保留數量或勾選 **dry run** 先預覽要刪哪些

`latest` 標籤所在的 version 永遠不會被刪除。實作見 [`.github/scripts/prune-ghcr.sh`](./.github/scripts/prune-ghcr.sh)。

---

## 🔐 環境變數與安全設定 (Environment Variables)

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `TASK_API_TOKEN` | （未設定） | **僅供排程／CI／腳本**使用的自動化權杖。設定後，`/api/scan` 與 `/api/health-check` 的 POST 可帶 `x-task-token` 或 `Authorization: Bearer`，也可用於讀取受保護的日誌／鎖定資訊。人工操作請使用管理員密碼登入；瀏覽器不再需要、也不會保存此權杖。 |
| `SITE_URL` | （未設定） | 選填，用來**鎖定**對外正式網址。未設定時，網址由網頁「⚙️ 設定 → 🌐 網站網址」管理，儲存於 `data/site.json`；兩者皆無時使用內建預設 `https://ui2.mahabodhi.co`。**一旦設定此變數即優先於網頁設定**，且網頁欄位會變為唯讀——適合 CI 或唯讀檔案系統的部署。 |
| `SITE_SETTINGS_FILE` | `<cwd>/data/site.json` | 網頁設定（canonical 網址）的儲存位置。容器內為 `./data` 綁定掛載，重啟後仍保留。 |
| `ADMIN_PASSWORD_FILE` | `<cwd>/data/admin.json` | 管理員密碼雜湊檔（JSON，權限 `0600`）。由 `npm run admin:password` 或容器內 CLI 建立；檔案內容永遠不含明文密碼。這是唯一可由網頁「變更密碼」寫入的來源。 |
| `ADMIN_PASSWORD_HASH` | （未設定） | 直接提供 scrypt 雜湊（格式 `scrypt:N:r:p:keylen:salt:hash`）。優先於所有檔案來源，適合唯讀／CI 部署。 |
| `ADMIN_PASSWORD_HASH_FILE` | （未設定） | 僅含 scrypt 雜湊的檔案路徑；優先於 `ADMIN_PASSWORD_FILE`，適合 Docker secret。 |
| `ADMIN_SESSION_TTL_MINUTES` | `720`（12 小時） | 管理員工作階段有效期（5–10080 分鐘）。工作階段存於記憶體，程序重啟即失效。 |
| `ADMIN_ALLOWED_ORIGINS` | （未設定） | 選填的逗號分隔精確來源清單（例如 `https://example.com`）。設定後，管理員 POST 的 `Origin` 必須完全符合；未設定時比對請求主機。 |
| `ADMIN_ALLOW_INSECURE_HTTP` | （未設定） | 生產環境預設拒絕以明文 HTTP 提交管理員密碼。僅在完全隔離的可信網路中才設為 `1`；此模式也會停用頁面 CSP 的 `upgrade-insecure-requests`，避免純 HTTP 部署的資產被升級到不存在的 TLS 連接埠。 |
| `ADMIN_COOKIE_SECURE` | `auto` | `auto` 依 HTTPS 自動加上 `Secure`；也可明確設為 `true`／`false`。 |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `10` | 每個來源每 15 分鐘的登入嘗試上限；超過回 `429`。 |
| `ADMIN_LOGIN_GLOBAL_FAILURES` | `500` | 15 分鐘內全域失敗上限，避免輪換來源 IP 造成無限制的 scrypt 計算。 |
| `ADMIN_AUDIT_LOG` | `<cwd>/data/logs/admin.log` | 管理員登入與操作稽核檔（`0600`）。預設超過 1 MB 輪替並保留 5 份編號備份（`.1`–`.5`）。設為 `off` 可停用。 |
| `ADMIN_AUDIT_MAX_BYTES` | `1048576`（1 MB） | 稽核檔輪替大小門檻（1–67108864 bytes）。 |
| `ADMIN_AUDIT_MAX_FILES` | `5` | 保留的編號備份數量（1–20）。輪替時最舊的備份會被刪除。 |
| `ADMIN_TOTP_SECRET` | （未設定） | 選填的 base32 TOTP 密鑰。設定後會覆寫 `admin.json` 內的 TOTP，適合唯讀／CI 部署；此時網頁不可管理 TOTP。未設定時由網頁啟用或 CLI 管理。 |
| `ADMIN_TOTP_WINDOW` | `1` | 允許的 TOTP 時間步偏移（0–2）。預設容忍前後各一個 30 秒時間步的時鐘誤差；調大只會放寬驗證窗口。 |
| `MEDIA_CACHE_MAX_BYTES` | `21474836480`（20 GB） | 媒體快取目錄的磁碟上限，超過即依 LRU 淘汰。 |
| `MEDIA_CACHE_MAX_FILE_BYTES` | `4294967296`（4 GB） | 單一媒體檔案的快取上限，超過則不快取。 |
| `MEDIA_CACHE_MAX_CONCURRENCY` | `3` | 同時進行的背景下載數量上限，避免被抓取大量檔案耗盡頻寬與 I/O。 |
| `PROXY_PRELOAD_MAX_PER_MINUTE` | `20` | 每個來源 IP 每分鐘可觸發 `action=preload` 的次數上限。 |
| `TRUST_PROXY` | （未設定） | 設為 `1` 時才信任 `X-Forwarded-For`（速率限制來源 IP）以及 `X-Forwarded-Proto`／`X-Forwarded-Host`（HTTPS 判斷與 CSRF 主機比對）。**僅在容器只經由會覆寫這些標頭的代理（如 Caddy）連線時才可開啟**；compose 已預設開啟，並將 8410 綁在 loopback。未設定時所有來源共用同一額度（保守但無法被偽造繞過）。 |
| `MEDIA_CACHE_MAINTENANCE_INTERVAL_MS` | `600000`（10 分鐘） | 定期清理 `.tmp` 孤兒檔並執行 LRU 淘汰的間隔（下限 30 秒）。 |
| `MEDIA_CACHE_DIR` | `<cwd>/data/media_cache` | 自訂快取目錄。**注意**：路徑必須包含 `data` 字串才會生效。 |

### 管理員登入與維護操作

「同步新媒體」與「自我巡檢修復」會改寫資料庫，因此需要管理員授權。**觀看課程與播放不受影響**；`action=preload` 也仍由一般播放自動觸發，不需要登入，但現在必須使用 **POST**（一般媒體播放仍是 GET）。

1. 設定管理員密碼（至少 8 個字元）：

```bash
# 原始碼環境
npm run admin:password

# Docker：直接執行即可
docker compose exec ui2 node scripts/admin-password.mjs
```

> **容器內不需要 `-u node`。** 映像檔刻意不設 `USER node`：entrypoint 需要 root 來校正 bind mount 的 `./data` 擁有者，之後才用 su-exec 降權執行應用程式。因此 `docker compose exec` 進去的 shell 本來就是 root。
>
> 以 root 執行時，腳本寫完 `0600` 檔案後會自動 `chown` 給應用程式實際使用的使用者（預設 `node`，uid 1000），所以檔案一定讀得到。若容器內沒有 `node` 帳號，可用 `ADMIN_FILE_OWNER=uid:gid` 指定，或先 `chown` 後再登入。
>
> 舊版腳本會直接以「Refusing to write as root」中止，並叫你回主機改用 `-u node` 重跑 —— 但人在容器內時這條指令無效，等於無法初始化密碼。現已修正。
>
> 若你已經用舊版寫出 root 擁有的 `data/admin.json`，`docker compose restart ui2` 就會由 entrypoint 自動修正擁有者。

腳本會隱藏輸入並要求確認，只把 scrypt 雜湊寫入 `data/admin.json`（權限 `0600`）。變更密碼後，既有工作階段會因雜湊指紋不符而立即失效。若要以唯讀環境變數部署，可用 `npm run admin:password -- --hash` 產生 `ADMIN_PASSWORD_HASH` 的值。

登入後可在同一張管理員卡片直接「變更密碼」與管理 TOTP；網頁變更只會寫入 `ADMIN_PASSWORD_FILE`，若使用 `ADMIN_PASSWORD_HASH`／`ADMIN_PASSWORD_HASH_FILE` 會回 `ADMIN_PASSWORD_MANAGED_EXTERNALLY`，請改由部署設定更新。

2. 開啟「📜 媒體同步與掃描紀錄」頁籤，在「🔑 管理員登入」輸入密碼。若已啟用 TOTP，第二步會要求輸入驗證器目前的 6 位數驗證碼。登入成功後會取得 `HttpOnly; SameSite=Strict` 的 12 小時工作階段 cookie（HTTPS 時另加 `Secure`）；可按「登出」立即撤銷。

3. 啟用雙因素驗證（建議）：登入後在「🔐 帳號安全」按「啟用 TOTP」，在驗證器 App 手動輸入顯示的密鑰（或貼上支援的 `otpauth://` URI），再輸入目前的 6 位數驗證碼與管理員密碼確認。啟用後每次登入都需驗證碼；同一個驗證碼不可重複使用。

4. 若驗證器遺失，可在伺服器以 CLI 復原（需要檔案系統權限）：

```bash
# Docker：先停用 TOTP，再重新登入網頁
# （若設定了 ADMIN_TOTP_SECRET，請先從部署環境移除，否則環境值仍會覆寫檔案）
docker compose exec ui2 node scripts/admin-password.mjs --disable-totp

# 也可重新產生一組密鑰
docker compose exec ui2 node scripts/admin-password.mjs --enable-totp
```

5. 自動化排程仍可使用 `TASK_API_TOKEN`：

```bash
curl -X POST https://your.host/api/scan \
  -H "X-Task-Token: $TASK_API_TOKEN"
```

注意事項：

- 生產環境的登入預設只接受 HTTPS。若在前面使用 Caddy，compose 已設定 `TRUST_PROXY=1`，讓應用程式從 `X-Forwarded-Proto` 正確判斷 HTTPS；請勿將 8410 連接埠直接暴露到公網。
- 管理員工作階段儲存在單一 Node 程序記憶體中。重啟容器即登出所有管理員；若未來改為多副本部署，需改用共享工作階段儲存。
- 憑證來源優先序為 `ADMIN_PASSWORD_HASH` → `ADMIN_PASSWORD_HASH_FILE` → `ADMIN_PASSWORD_FILE`。明確設定的來源若損壞或不存在會 **fail closed**，不會悄悄退回其他來源。TOTP 則以 `ADMIN_TOTP_SECRET` 為優先，未設定時讀取檔案中的 `totpSecret`。
- 網頁密碼變更需要目前密碼；若已啟用 TOTP，還需要目前的驗證碼。成功後會撤銷所有管理工作階段並發出新的 cookie。
- `admin.json` 同時包含 scrypt 雜湊與（啟用時）TOTP 密鑰，請備份並維持 `0600`；兩者都足以影響管理員存取。
- 掃描狀態 API 的公開部分（課程數、最近同步時間、快取統計）仍可匿名讀取；`recentLogs` 與 `lockHolder` 僅在管理員工作階段或自動化權杖下回傳。

### 安全機制

- **管理員端點不再信任同源請求**：`/api/scan`、`/api/health-check` 的 POST 需要有效的管理員工作階段，或明確設定的 `TASK_API_TOKEN`。`Origin`／`Host`／`Sec-Fetch-*` 都是請求端可自行填寫的值，不能當作授權憑證。
- **管理員 CSRF 防護**：登入、登出與維護 POST 需通過 `Origin`（或 `Referer`）主機比對、`X-Admin-Request: 1` 自訂標頭，登入另需 `Content-Type: application/json`；跨站請求直接拒絕。
- **登入暴力破解防護**：每個來源 15 分鐘內最多 10 次嘗試，另有全域失敗上限；超過回 `429` 並附 `Retry-After`。密碼驗證使用 scrypt，失敗回應有固定延遲。
- **管理員稽核紀錄**：登入成功／失敗、登出、密碼變更、TOTP 操作與維護操作寫入 `data/logs/admin.log`；不記錄密碼、雜湊、cookie 或權杖。預設每 1 MB 輪替，保留 5 份編號備份（可用 `ADMIN_AUDIT_MAX_BYTES`／`ADMIN_AUDIT_MAX_FILES` 調整）。
- **`action=preload` 與管理員登入脫鉤，且改為 POST**：一般播放可觸發快取預熱，採同源請求或 `TASK_API_TOKEN` 授權，並受速率限制（超過回 `429`）。GET `action=preload` 會回 `405`／`Allow: POST`，避免連結預取或圖片標籤造成磁碟寫入；一般媒體 GET 播放不受影響。它不會授予掃描／修復權限。
- **速率限制不可用 `X-Forwarded-For` 偽造繞過**：來源鍵預設不信任該標頭（見 `TRUST_PROXY`），且 bucket 數量有上限，避免以輪換來源 IP 撐爆記憶體。
- **上游白名單同時鎖定協定與埠號**：僅允許 `https://www.fayun.org` 與 `https://fayun.org` 的 **443** 埠，避免代理被用來探測其他服務。
- **頁面回應強化**：HTML 頁面由 `src/proxy.ts` 加上 CSP（限制外部 script／connect／frame 來源）、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`nosniff`、Referrer-Policy 與 Permissions-Policy，降低 XSS 與點擊劫持風險。
- **代理回應強化**：`/api/proxy` 不套用頁面的 framing 規則，因此同源 PDF iframe 與影音播放不受影響。代理的媒體／檔案回應帶 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 與 `Cross-Origin-Resource-Policy: same-origin`；音訊、影片與 PDF（以及 `application/octet-stream`）刻意以 `inline` 提供且不套用 `sandbox` CSP，否則瀏覽器內建的 PDF 檢視器會被擋下。其餘非影音類型套用 `Content-Security-Policy: default-src 'none'; sandbox`，快取未命中時並強制 `Content-Disposition: attachment`；`text/html`、SVG、XML 等可執行文件類型一律拒絕。
- **容器非特權執行**：應用程式以 `node` 使用者執行，並於 compose 設定 `no-new-privileges`；容器僅保留 `CHOWN`/`DAC_OVERRIDE`/`SETUID`/`SETGID` 用於啟動時修正 `./data` 權限，隨後即降權。
- **連接埠僅綁定 loopback**：compose 將 `8410` 綁在 `127.0.0.1`，外部流量一律須經 Caddy。這可同時避免有人直連繞過代理，以及讓 `X-Forwarded-For` 失去可信度。

---

## 🌐 自訂網域與社群分享預覽 (Custom Domain & Link Previews)

正式網域為 **`https://ui2.mahabodhi.co`**，由 Caddy 反向代理到容器的 `127.0.0.1:8410`。

### 設定步驟

1. **DNS**：將 `ui2.mahabodhi.co` 的 `A`（或 `AAAA`）記錄指向主機 IP。
2. **Caddy**：`Caddyfile` 預設以 `:443`／`:8443` 搭配 `tls internal` 提供自簽憑證（僅適合本機／內網）。對外站台請改成網域站點，Caddy 會自動申請並續訂 Let's Encrypt 憑證：

   ```caddyfile
   (ui2_proxy) {
       reverse_proxy {$UPSTREAM:ui2:8410} {
           header_up X-Forwarded-For {remote_host}
           header_up X-Forwarded-Proto {scheme}
           header_up X-Forwarded-Host {hostport}
       }
   }

   ui2.mahabodhi.co {
       import ui2_proxy
   }
   ```

   倉庫內的 `Caddyfile` 已備好這兩種模式（預設本機、另一段註解即正式網域），切換時**註解掉 `:443, :8443` 區塊**。切勿在網域站點保留 `tls internal`，否則會把自簽憑證發給公網訪客。

3. **設定網址**：登入管理員後，於「⚙️ 設定 → 🔐 帳號安全」下方的 **🌐 網站網址** 填入正式網址即可，**不需要重啟、也不需要重新編譯**。值儲存於 `data/site.json`（權限 `0600`）。

   若要以環境變數強制鎖定（例如 CI 或唯讀部署），改設 `SITE_URL=https://your.domain`；此時網頁欄位會變為唯讀並標示來源。

### 網址優先順序

| 順位 | 來源 | 說明 |
| --- | --- | --- |
| 1 | 環境變數 `SITE_URL` | 有設定就勝出，網頁欄位唯讀 |
| 2 | `data/site.json` | 由管理員網頁設定 |
| 3 | 內建預設 `https://ui2.mahabodhi.co` | 兩者皆無時使用 |

### 為什麼不能自動推斷

`og:url`、`canonical` 與 `og:image` 都必須是**絕對網址**。應用程式在反向代理之後，`Host` 標頭可由客戶端偽造，因此不能拿來當 canonical；必須由管理員明示。

修改後 `<link rel="canonical">` 與 `og:url` 會在**下一次請求**立即反映（`/` 因此改為請求時渲染）。但社群平台端仍有快取，需依下方說明重新抓取。

### 驗證分享卡片

改完網域後，先確認標籤正確：

```bash
curl -s https://ui2.mahabodhi.co/ | grep -E 'og:|twitter:|canonical'
```

應可看到 `og:site_name` 為 `妙境法軒`、`og:image` 指向 `https://ui2.mahabodhi.co/og-image.png`（1200x630）。

社群平台會**快取**預覽圖，換圖或改名後需要用官方工具強制重新抓取：

- Facebook／Messenger：[Sharing Debugger](https://developers.facebook.com/tools/debug/) → 貼上網址 → **Scrape Again**
- X／Twitter：撰寫推文時會自動重抓；必要時在網址後加 `?v=2` 破快取
- LINE：貼到 `LINE` 聊天室即可預覽，舊圖有快取，通常數小時後更新
- Telegram：`@WebpageBot` 貼上網址可強制更新

### PWA 安裝

`/manifest.webmanifest` 由 `src/app/manifest.ts` 產生，圖示為 `public/` 下的 PNG：

| 檔案 | 尺寸 | 用途 |
| --- | --- | --- |
| `icon-32.png`／`favicon-48.png` | 32／48 | 瀏覽器分頁圖示 |
| `apple-touch-icon.png` | 180 | iOS 加入主畫面 |
| `icon-192.png`／`icon-512.png` | 192／512 | Android／桌面安裝（另宣告 `maskable`） |
| `og-image.png` | 1200x630 | 社群分享卡片 |

圖示由 `scripts/make-icons.py` 產生（蓮花標記、米金底、金框），修改配色或樣式後重跑該腳本即可。

---

## 📄 授權說明 (License)

影音與講義內容版權均屬 [fayun.org (美國法雲寺 / 法雲資訊網)](https://www.fayun.org) 所有。本 Web 平台僅供佛法講記典藏學習與研讀交流使用。
