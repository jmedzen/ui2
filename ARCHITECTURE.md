# 架構說明 (Architecture)

妙境法軒典藏平台的內部結構、資料流與設計取捨。面向要修改這個專案的開發者；
若只想跑起來，請看 [README](./README.md)。

---

## 1. 整體形狀

單一 Next.js 16 App Router 應用，同時擔任三種角色：

1. **前端**：React 19 客戶端元件（`src/components`、`src/app/page.tsx`）
2. **BFF／代理**：`src/app/api/*` 的 Route Handlers，向上游 `fayun.org` 取用目錄與媒體
3. **維運後台**：管理員認證、掃描同步、自我巡檢，全部走同一組 API

沒有獨立的資料庫服務。狀態放在三個地方：

| 存放 | 內容 | 生命週期 |
| --- | --- | --- |
| `data/courses_db.json` | 課程目錄（掃描器重寫） | 永久，容器需掛載 |
| `data/media_cache/` | 媒體快取（LRU，上限 20 GB） | 可重建 |
| `localStorage` | 播放進度、最愛、主題、字級、分頁位置 | 各瀏覽器各自持有 |

```
Browser
  │
  ├─ page.tsx ──────── 全站狀態（課程、選取、主題、行動版偵測）
  │    ├─ TreeNav ──── 684 筆課程樹、搜尋、媒體快篩
  │    ├─ HomePortal ─ 首頁入口、學習法種類、每日推薦
  │    ├─ CourseDetail ─ 五個分頁
  │    │    ├─ AudioTab ─────── 搜尋、卷次、分批集數清單
  │    │    ├─ VideoPlayer
  │    │    ├─ PdfViewer
  │    │    └─ ListErrorState
  │    ├─ GlobalAudioPlayer ── 跨頁懸浮播放器
  │    └─ SettingsModal ────── 主題、字級、網站網址、管理員
  │
  └─ AudioContext ──── 單一 <audio> 元素、播放清單、進度寫入
```

---

## 2. 為什麼是全站狀態集中在 `page.tsx`

`page.tsx`（698 行）持有 12 個 `useState`，並向下傳 18 個 props 給 `MainLayout`。
這是刻意的：側欄樹、首頁、課程頁、播放器都必須看到**同一份**選取狀態與課程清單。

代價是 prop drilling。若日後要再拆，正確的做法是抽一個 `SiteStateContext`，
而不是把狀態分散到各子樹——後者會讓「點樹上的課程」與「首頁點卡片」走出兩條
不一致的路徑。

---

## 3. 媒體探索：三個 hook

課程的音訊、影音、講義清單都不在資料庫裡，而是**執行時向上游列目錄**才發現。

原本這三段邏輯與渲染綁在同一個 1,524 行的元件裡。現已拆開：

| 檔案 | 職責 |
| --- | --- |
| `lib/courseMedia.ts` | 純函式：`canonicalPdfPath`、`sharedRootDirFor`、`sortVolumes` |
| `lib/useAudioTracks.ts` | 音訊探索、卷次清單、失敗狀態 |
| `lib/useVideoTracks.ts` | 影音探索 |
| `lib/usePdfTracks.ts` | 講義探索、跨目錄去重 |

三個 hook 都吃 `(course, reloadToken)`：

- **`course`** 改變 → 重新探索
- **`reloadToken`** 由讀者的「重新載入」按鈕遞增 → 在不換課程的情況下重跑

各自持有 `isLoading` 與 `error`，所以影音清單壞掉不會讓音訊清單顯示錯誤。

### 探索的兩個陷阱

**（一）`queryDirectory` 會吞掉自己的錯誤。** 一個候選路徑失敗不該中止整輪探測，
但這也讓呼叫端無法分辨「全部失敗」與「全部都空」。音訊 hook 因此額外記
`probeAttempts` / `probeFailures`：只有在「沒找到任何檔案 **且** 每次探測都失敗」
時才顯示錯誤。部分成功時，空清單才是誠實的答案。

**（二）PDF 會從多個目錄被發現。** 同一份檔案可能同時經由 `.../bilu` 與其父目錄
出現，兩者 URL 不同。因此以 `canonicalPdfPath(folder, name)`（收斂重複路徑段 +
正規化檔名）作為去重鍵，而不是比對完整 URL。

### 多卷課程的範圍限定

`瑜伽師地論．本地分` 有 51 卷、503 份 PDF。早期所有卷次頁都退回共同根目錄探測，
於是每一卷都列出整棵樹的檔案，並把 URL 合成到檔案從未存在的資料夾
（實測：課程 163 只有 8 份講義，卻發現 503 份）。

`sharedRootDirFor(course)` 以**課程名稱**的卷次標記為準：

- 恰好一個卷次標記（`卷14`）→ 限定在該卷目錄
- 完全沒有「卷」字 → 這是根課程，整棵樹都是它的
- 多個標記（`卷12至13-1`）→ 退回該課程自己 PDF URL 所暗示的目錄

卷次 token 必須完整捕捉：`卷12至13-1` 是真實存在的目錄名，只取前導數字會探測到
不存在的 `卷12` 而什麼都找不到。

---

## 4. 大批清單的渲染策略

`瑜伽師地論` 有 969 集。全部渲染產生 **7,945 個 DOM 節點、986 個按鈕**，
且每次在搜尋框輸入都會重新 filter 並重繪全部 969 列。

現行做法（`AudioTab.tsx` + `CourseDetail.tsx`）：

- 每批 `EPISODE_BATCH_SIZE = 100` 集
- `IntersectionObserver` 在哨兵元素進入視窗（含 600px 前餵）時續載
- 保留「載入更多」按鈕給無法捲動的鍵盤使用者
- 切換課程／卷次／搜尋字串時回到第一批

一般 30–80 集的課程一批就顯示完，看不到任何「載入更多」。

實測 969 集頁面：**996 個節點、118 個按鈕**。

---

## 5. 狀態持久化

`localStorage` 一律經由 `lib/stringStore.ts`，不直接呼叫。原因是**快照識別**：
`useSyncExternalStore` 要求 `getSnapshot()` 在資料未變時回傳同一個引用，否則會無限
重繪。`createStringStore` 以原始 JSON 字串為鍵快取解析結果，保證引用穩定。

| 鍵 | 內容 |
| --- | --- |
| `fayun_progress_v1` | `{courseId: {filename: {t, d, at}}}` 播放進度 |
| `fayun_favorites_v1` | 最愛課程 |
| `fayun_player_prefs_v1` | 音量、倍速、循環模式 |
| `fayun_recent_course_ids` | 最近研讀 |
| `fayun_last_tab_<id>` | 各課程上次停留的分頁 |
| `fayun_last_video_idx_<id>` | 各課程上次觀看的影音集數 |
| `fayun_split_ratio` | 雙欄分割比例（25–75） |
| `fayun_settings_modal_width` | 設定面板寬度 |

**續播門檻**（`playbackStore.ts`）：`t < 15s` 不續播（視為誤觸）；
`t >= d - 30s` 也不續播（視為已看完）。兩者都回傳 0。

**不可在 render 期間讀寫。** 讀會造成 hydration 不一致，寫會觸發重繪迴圈。
一律在 effect 或事件處理器中進行；需要在 render 期間「同步」的狀態（例如切換課程
時重置分頁）採「以 id 標記在 render 中比對」的慣用寫法：

```ts
const [tabCourseId, setTabCourseId] = useState(course.id);
if (tabCourseId !== course.id) {
  setTabCourseId(course.id);
  // 重置相關狀態
}
```

這是刻意的例外，已獲 eslint 規則允許；其他地方的 `eslint-disable` 只有 3 處，
且都註明理由。

---

## 6. 每日推薦為什麼不用亂數

`lib/dailyPicks.ts` 的「每 24 小時更新」是**依日期決定性地選取**，不是
`Math.random()` 加時間戳：

- render 期間用 `Math.random()` 每次結果都不同，伺服器與客戶端也會不一致
  （hydration mismatch）
- 把「抽選時間」存進 `localStorage` 則每個訪客各有自己的輪替，網站就沒有共同的
  「今日推薦」，且無痕視窗每次都從頭開始

以 `(日期, 目錄)` 推導，則所有人看到相同三門課、同一天內重載不變、且可伺服器渲染。

日界線固定在 **UTC+8**，不跟隨主機時區：容器通常跑 UTC，用本地時區會讓換日發生在
目標讀者的早上 8 點。

---

## 7. 樣式系統

4,626 行的 `globals.css` 已按關注點拆為四份，由 `globals.css` 依序 `@import`：

| 檔案 | 行數 | 內容 |
| --- | --- | --- |
| `styles/base.css` | 53 | reset、`--font-scale` 基底 |
| `styles/themes.css` | 130 | 六套主題 × 15 個 CSS 變數 |
| `styles/layout.css` | 633 | 外殼、側欄、目錄樹、播放列 |
| `styles/components.css` | 3,810 | 分頁、清單、PDF、設定、首頁 |

**順序即級聯。** 後面的規則覆寫前面的，拆分時保持原檔順序，串接結果與原檔逐位元
相同；渲染結果經截圖雜湊比對為逐像素一致。

### 字級縮放

讀者可在設定中調整 12–28px 全站字級，機制是 `--base-font-size` → `--font-scale`：

```css
.app-root { --font-scale: calc(var(--base-font-size, 16px) / 16px); }
.some-text { font-size: calc(13px * var(--font-scale)); }
```

全站 198 處使用這個模式。**新增文字樣式請照此撰寫**，否則該處不會跟隨設定縮放。
僅 5 處刻意寫死 px，皆為 emoji／箭頭圖示（縮放會破壞對齊），已加註解說明。

### 主題與對比

`themes.css` 的六套主題各自定義同樣 15 個變數。`--text-muted` 的取值已調整到
六套主題全部通過 WCAG AA（4.5:1，對 `--bg-card`），同時仍低於 `--text-secondary`
以保住視覺層級：

| 主題 | `--text-muted` | 對比 |
| --- | --- | --- |
| dark | `#808ea1` | 4.68 |
| light | `#6a7682` | 4.64 |
| pine | `#5eead4` | 10.67 |
| sandalwood | `#b09584` | 5.34 |
| zen | `#7a716a` | 4.62 |
| gruvbox | `#b1a28a` | 4.64 |

調整任何主題色後請重新驗算，`--text-muted` 用在 46 處、多為 11–13px 小字，
是最容易跌破門檻的地方。

---

## 8. 後端

### 代理與快取

`/api/proxy` 把 `fayun.org` 的媒體轉發給瀏覽器，並支援 **HTTP Range**（拖曳定位）。
可快取的檔案會落到 `data/media_cache/`，之後直接由本機磁碟串流。

- 上限 20 GB（`MEDIA_CACHE_MAX_BYTES`），超過依 LRU 淘汰
- 同時最多 3 個背景下載（`MEDIA_CACHE_MAX_CONCURRENCY`）
- 每 10 分鐘清理孤兒 `.tmp` 並執行淘汰
- 進行中的串流以引用計數標記，不會被淘汰

上游白名單同時鎖定**協定與埠號**：只允許 `https://www.fayun.org` 與
`https://fayun.org` 的 443，避免代理被拿來探測其他服務。

### 目錄快取

`/api/list-files` 對遠端目錄查詢做伺服器端 LRU 快取，重複造訪課程可 0ms 回應。
這是三個 hook 的資料來源。

### 任務與鎖

掃描與修復是長時間任務，`lib/serverTasks.ts`（1,027 行）以 `data/logs/scan.lock`
記錄持有者的 PID。鎖只在持有程序仍存活時生效，因此容器重啟不會留下永久誤判；
啟動時也會清除前次遺留的鎖。

### 認證與授權

管理員端點（`/api/scan` 的 POST、`/api/health-check`、`/api/admin/*`）需要
**有效工作階段**或明確設定的 `TASK_API_TOKEN`。

`Origin`／`Host`／`Sec-Fetch-*` 都是請求端可自行填寫的，不能當授權憑證——
早期曾以同源檢查當作授權，這是已被移除的設計。

其餘防線：scrypt 密碼雜湊、TOTP 雙因素、每來源與全域的登入速率限制、
CSRF 標頭檢查、稽核紀錄（`data/logs/admin.log`，1 MB 輪替保留 5 份）。
工作階段存在**單一程序記憶體**中，重啟即全部登出；多副本部署需改用共享儲存。

---

## 9. 測試

`npm test` 執行 40 個套件、**449 個案例**（`node:test` + `tsx`）。

多數套件直接讀原始碼做 regex 斷言，因為那些主題（安全性標頭、洩漏防護、UI 契約）
難以在沒有瀏覽器的情況下實際執行。這有代價：**改字串或搬位置就會讓測試失敗**。

本專案對此的處理原則：

- 斷言意圖而非字面。例：不斷言「某行存在」，而斷言「空清單不得顯示為載入中」。
- 能直接測行為的就直接測。`canonicalPdfPath` 等純函式已從元件抽到
  `lib/courseMedia.ts`，測試改為 `import` 呼叫，不再 regex 抽取後 `eval`。
- 樣式相關斷言改讀 `tests/helpers/styles.ts` 的 `readAllStyles()`，
  在 CSS 拆分後仍涵蓋全部章節。

會讀寫媒體快取或任務鎖的測試，第一行必須 `import './helpers/isolated-media-cache'`，
讓 `MEDIA_CACHE_DIR` 與 `TASK_LOG_DIR` 指向暫存沙盒；否則會在 `data/logs`
留下 `scan.lock`，被同時執行的開發伺服器誤判為有任務在跑。

### 驗證關卡

```bash
npm run lint          # eslint，目前 0 problems
npm test              # 449 案例
npx tsc --noEmit      # 型別
npm run build         # 生產編譯
npm run verify        # 上述＋資料庫比對＋快取上限＋行動版配置
```

---

## 10. 已知取捨

**`page.tsx` 仍是最大的狀態容器。** 18 個 props 傳給 `MainLayout`。要拆需先引入
`SiteStateContext`，但這會動到所有子樹，風險高於收益，暫緩。

**`SettingsModal.tsx`（1,079 行）與 `serverTasks.ts`（1,027 行）仍偏大。**
前者可再拆出「主題」「字級」「網站網址」「管理員」四個面板，但四者共用同一份
modal 尺寸與分頁狀態，拆了要再傳一次。後者是任務狀態機，本身內聚，優先度低。

**部分測試綁定原始碼字串。** 這是安全的可讀性與可測性之間的折衷，代價是重構時
需同步更新斷言。已逐步改為直接測行為，但安全標頭類的斷言仍必須讀原始碼。

**無 `prefers-color-scheme` 自動跟隨以外的系統整合。** 主題以 JS 管理並寫入
`localStorage`，`system` 選項會讀取 `prefers-color-scheme`，但不使用
CSS media query 雙寫，避免兩套真實來源。

**沒有虛擬滾動，只有分批。** 969 集的清單以每批 100 集渲染。真正的視窗化
（只保留可見區段）能再降低節點數，但會增加捲動位置還原與 `Ctrl+F` 的複雜度，
在目前節點數（996）下收益有限。
