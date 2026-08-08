# 🌸 法雲資訊網 — 典藏課程 Web 平台 (Fayun Web UI)

一個基於 **Node.js + Next.js App Router + React + TypeScript** 打造的高效能、美觀且功能完備的現代化 Web 瀏覽平台，完整收錄 `fayun.org` 玅境長老一生講述之佛法經論、禪修止觀、戒律與專題開示資料。

包含 400+ 門課程、音訊 MP3/M4A 線上串流播放、影音影片觀看、以及 1000+ 份 PDF 講義筆記線上對照閱讀。

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
- 目錄區設有 **`🔄 手動觸發掃描/同步`** 按鈕，點擊即可連線 `fayun.org` 掃描檢查是否有新上架的經典與媒體資源，並自動更新數據庫。

---

## 🛠️ 技術棧 (Tech Stack)

- **前端與框架**：Next.js 14+ / 15 (App Router), React 19, TypeScript
- **狀態管理**：React Context API (`AudioContext`) + LocalStorage
- **視覺與設計**：Vanilla CSS Custom Design System (Modern Zen Aesthetics Theme)
- **後端 API Services**：Next.js Node.js Route Handlers (`/api/courses`, `/api/list-files`, `/api/proxy`, `/api/scan`)
- **媒體處理解析**：Python 3 Data Ingestion Scripts (`scripts/scan_fayun.py`)

---

## 📂 專案結構 (Directory Structure)

```
fyweb/
├── public/                    # 靜態資源
├── scripts/
│   ├── build_unified_db.py   # 課程資料庫建置腳本
│   └── scan_fayun.py         # fayun.org 媒體庫掃描腳本
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── courses/      # 全站課程索引 API
│   │   │   ├── list-files/   # 遠端目錄檔案查詢 API (附 Server Cache)
│   │   │   ├── proxy/        # 音訊/影片/PDF 串流代理 API
│   │   │   └── scan/         # Web 媒體掃描同步 API
│   │   ├── globals.css       # 現代禪風主題樣式系統
│   │   ├── layout.tsx        # 根版面與 SEO Metadata
│   │   └── page.tsx          # 響應式主頁面與樹狀導覽
│   ├── components/
│   │   ├── AudioPlayer.tsx        # 音訊播放組件
│   │   ├── CourseDetail.tsx       # 課程詳細與雙欄對照組件
│   │   ├── GlobalAudioPlayer.tsx  # 全站全域懸浮播放器
│   │   ├── PdfViewer.tsx          # PDF 講義閱讀器
│   │   ├── TreeNav.tsx            # 極簡樹狀目錄與防抖搜尋
│   │   └── VideoPlayer.tsx        # 影音影片播放器
│   ├── context/
│   │   └── AudioContext.tsx       # 全域音訊狀態上下文
│   ├── data/
│   │   └── courses_db.json        # 高速索引課程資料庫
│   └── types/
│       └── course.ts              # TypeScript 型態定義
├── package.json
├── scanner.log                # 媒體同步歷史日誌
└── tsconfig.json
```

---

## 🚀 快速開始 (Getting Started)

### 1. 安裝依賴
```bash
npm install
```

### 2. 啟動開發伺服器 (Development Server)
```bash
npm run dev
```
開啟瀏覽器訪問：`http://localhost:3000` (或 `http://localhost:3001`)

### 3. 編譯生產版本 (Production Build)
```bash
npm run build
npm run start
```

---

## 🐳 Docker & GHCR 容器化部署 (GitHub Container Registry)

本專案配置 GitHub Actions CI/CD 工作流，每次更新 `main` 分支均自動編譯並發布 Docker Image 至 GitHub Container Registry。

### 1. 拉取 GHCR 鏡像並運行：
```bash
docker pull ghcr.io/jmedzen/ui2:latest
docker run -d -p 8410:8410 --name fyweb ghcr.io/jmedzen/ui2:latest
```
開啟瀏覽器造訪：`http://localhost:8410`

### 2. 本機 Docker 手動編譯：
```bash
docker build -t fyweb:latest .
docker run -d -p 8410:8410 fyweb:latest
```

---

## 📄 授權說明 (License)

影音與講義內容版權均屬 [fayun.org (美國法雲寺 / 法雲資訊網)](https://www.fayun.org) 所有。本 Web 平台僅供佛法講記典藏學習與研讀交流使用。
