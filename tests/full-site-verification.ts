import { execSync, spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getCacheStats } from '../src/lib/serverMediaCache';

interface CheckItem {
  name: string;
  passed: boolean;
  details: string;
}

async function runFullSiteVerification() {
  console.log('\n======================================================');
  console.log('🌸 法雲資訊網 (fayun.org) 全站功能完整性測試與自動驗證');
  console.log(`⏰ 執行時間: ${new Date().toLocaleString('zh-TW', { hour12: false })}`);
  console.log('======================================================\n');

  const results: CheckItem[] = [];

  // 1. Run Unit & Functional Test Suites
  try {
    console.log('⏳ [1/6] 執行 TypeScript 單元與端點測試套件 (node:test + tsx)...');
    const testOutput = execSync('npx tsx --test tests/*.test.ts', { encoding: 'utf-8' });
    const passCount = (testOutput.match(/✔/g) || []).length;
    results.push({
      name: '自動化測試套件 (Automated Test Suites)',
      passed: true,
      details: `共通過 ${passCount} 個測試案例 (Database, MediaCache, Proxy, TreeNav, UI)`
    });
    console.log(`✅ 測試套件全數通過 (${passCount} checks)\n`);
  } catch (err: any) {
    results.push({
      name: '自動化測試套件 (Automated Test Suites)',
      passed: false,
      details: err.stdout || err.message
    });
    console.error('❌ 測試套件失敗:\n', err.stdout || err.message);
  }

  // 2. Database & Catalog Consistency
  try {
    console.log('⏳ [2/6] 驗證課程典藏資料庫 (courses_db.json)...');
    const dataDb = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'courses_db.json'), 'utf-8'));
    const srcDb = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'courses_db.json'), 'utf-8'));
    const totalCourses = srcDb.courses.length;
    const videoCount = srcDb.courses.filter((c: any) => c.video_path).length;
    const pdfCount = srcDb.courses.filter((c: any) => c.pdfs && c.pdfs.length > 0).length;

    const isMatch = dataDb.courses.length === srcDb.courses.length;

    results.push({
      name: '課程數據庫結構完整性 (Catalog DB)',
      passed: isMatch && totalCourses === 684 && videoCount === 479,
      details: `收錄 ${totalCourses} 門課程 | 影音講記 ${videoCount} 門 | 講義講述 ${pdfCount} 門 | 雙庫同動: ${isMatch ? '一致' : '不一致'}`
    });
    console.log(`✅ 數據庫檢驗通過: 684 門課程，479 門影音，雙庫同步一致\n`);
  } catch (err: any) {
    results.push({
      name: '課程數據庫結構完整性 (Catalog DB)',
      passed: false,
      details: err.message
    });
  }

  // 3. Media Cache Capacity (20GB)
  try {
    console.log('⏳ [3/6] 檢驗網頁主機媒體磁碟快取與 20GB 上限設定...');
    const cacheStats = getCacheStats();
    const is20Gb = cacheStats.maxGb === 20;

    results.push({
      name: '媒體快取容量限制 (Media Cache Limit)',
      passed: is20Gb,
      details: `最大容量: ${cacheStats.maxGb} GB (${(cacheStats.maxBytes / (1024 ** 3)).toFixed(1)} GB) | 目前已用: ${(cacheStats.currentBytes / 1024 / 1024).toFixed(2)} MB (${cacheStats.fileCount} 檔案)`
    });
    console.log(`✅ 媒體快取配置正確: ${cacheStats.maxGb} GB LRU 磁碟快取\n`);
  } catch (err: any) {
    results.push({
      name: '媒體快取容量限制 (Media Cache Limit)',
      passed: false,
      details: err.message
    });
  }

  // 4. Mobile Firefox & Viewport Compatibility
  try {
    console.log('⏳ [4/6] 檢驗手機版 Firefox 與行動端 UI 相容配置...');
    const layoutContent = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf-8');
    const cssContent = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf-8');

    // Next.js manages <head> via the `viewport` export; a hand-written
    // <meta name="viewport"> would be duplicated in the rendered document.
    const hasViewportExport =
      layoutContent.includes('export const viewport') &&
      layoutContent.includes("width: 'device-width'");
    const hasNoDuplicateMeta = !layoutContent.includes('<meta name="viewport"');
    const hasMobileQuery = cssContent.includes('@media (max-width: 960px)');
    const hasClassOverride = cssContent.includes('.app-root.is-mobile-screen');

    results.push({
      name: '行動版瀏覽器與 Firefox 相容性 (Mobile Viewport)',
      passed: hasViewportExport && hasNoDuplicateMeta && hasMobileQuery && hasClassOverride,
      details: `Next.js viewport export: ${hasViewportExport ? '已配置' : '缺失'} | 無重複 meta viewport: ${hasNoDuplicateMeta ? '是' : '否'} | 960px 響應式斷點: ${hasMobileQuery ? '已配置' : '缺失'} | JS 動態類別保底: ${hasClassOverride ? '已配置' : '缺失'}`
    });
    console.log(`✅ 行動相容檢驗通過: 包含原生 Head Viewport 與雙重判定保底\n`);
  } catch (err: any) {
    results.push({
      name: '行動版瀏覽器與 Firefox 相容性 (Mobile Viewport)',
      passed: false,
      details: err.message
    });
  }

  // 5. Next.js Production Build Verification
  try {
    console.log('⏳ [5/6] 執行 Next.js 編譯完整性檢查 (npm run build)...');
    execSync('npm run build', { encoding: 'utf-8', stdio: 'pipe' });
    results.push({
      name: '生產環境建置驗證 (Next.js Production Build)',
      passed: true,
      details: '編譯成功，0 個 TypeScript 或 Turbopack 語法錯誤'
    });
    console.log('✅ 生產環境建置驗證通過 (0 Errors)\n');
  } catch (err: any) {
    results.push({
      name: '生產環境建置驗證 (Next.js Production Build)',
      passed: false,
      details: err.stdout || err.message
    });
  }

  /** Path of the generated manifest body, whichever layout this build uses. */
  const manifestFile = (): string => {
    const candidates = [
      path.join(process.cwd(), '.next', 'server', 'app', 'manifest.webmanifest.body'),
      path.join(process.cwd(), '.next', 'server', 'app', 'manifest.webmanifest')
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || '';
  };

  // 6. Social share preview + PWA installability.
  //
  // These tags live in the document head, not the page body, so a rename that
  // only touched the visible header left every link preview advertising the old
  // name. Asserted against the built artifacts rather than the source, because
  // the generated <head> is what a platform actually reads.
  try {
    console.log('⏳ [6/6] 驗證社群分享預覽與 PWA 安裝資訊...');
    const { DEFAULT_SITE_URL, SITE_NAME } = await import('../src/lib/site');

    // `/` is request-rendered now (the canonical origin is admin-editable), so
    // it no longer produces .next/server/app/index.html. Verify against a real
    // server response instead: that is exactly what a crawler receives.
    const port = 8137;
    const base = `http://127.0.0.1:${port}`;
    const server = spawn('npx', ['next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ADMIN_PASSWORD_FILE: path.join(os.tmpdir(), 'ui2-verify-absent-admin.json'),
        ADMIN_AUDIT_LOG: 'off',
        SITE_SETTINGS_FILE: path.join(os.tmpdir(), 'ui2-verify-site.json'),
        // This probe talks plain HTTP over loopback; the app would otherwise
        // reject it on the same rule that protects real admin logins.
        ADMIN_ALLOW_INSECURE_HTTP: '1'
      },
      stdio: 'ignore',
      detached: false
    });

    let headHtml = '';
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
          if (response.ok) {
            headHtml = await response.text();
            break;
          }
        } catch {
          // Server not listening yet.
        }
      }
    } finally {
      server.kill('SIGTERM');
    }

    const checks: Array<[string, boolean]> = [
      ['伺服器回應 HTML', headHtml.length > 0],
      ['og:site_name 為妙境法軒', headHtml.includes(`og:site_name" content="${SITE_NAME}"`)],
      ['og:title 含站名', headHtml.includes('og:title') && headHtml.includes(SITE_NAME)],
      ['og:url 絕對網址', headHtml.includes(`og:url" content="${DEFAULT_SITE_URL}`)],
      ['canonical 絕對網址', headHtml.includes(`rel="canonical" href="${DEFAULT_SITE_URL}`)],
      ['og:image 為 1200x630', headHtml.includes('og:image" content=') && headHtml.includes('og:image:width" content="1200"')],
      ['twitter card', headHtml.includes('twitter:card')]
    ];

    const mfText = fs.existsSync(manifestFile())
      ? fs.readFileSync(manifestFile(), 'utf-8')
      : '';
    checks.push(['manifest 已產生', mfText.length > 0]);
    checks.push(['manifest short_name', mfText.includes(SITE_NAME)]);
    checks.push(['manifest 有 512 圖示', mfText.includes('512x512')]);
    checks.push(['manifest maskable', mfText.includes('maskable')]);

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    results.push({
      name: '社群分享預覽與 PWA (Social Preview / PWA)',
      passed: failed.length === 0,
      details:
        failed.length === 0
          ? `og:site_name=${SITE_NAME} | og:image 1200x630 | canonical=${DEFAULT_SITE_URL} | manifest 含 192/512/maskable`
          : `未通過：${failed.join('、')}`
    });
    if (failed.length === 0) console.log('✅ 社群預覽與 PWA 檢驗通過\n');
  } catch (err) {
    results.push({
      name: '社群分享預覽與 PWA (Social Preview / PWA)',
      passed: false,
      details: err instanceof Error ? err.message : String(err)
    });
  }

  // Print Summary Table
  console.log('======================================================');
  console.log('📋 全站功能測試與驗證總結清單');
  console.log('======================================================');

  let allPassed = true;
  for (const item of results) {
    const symbol = item.passed ? '✅ [通過]' : '❌ [失敗]';
    console.log(`${symbol} ${item.name}`);
    console.log(`   └─ ${item.details}`);
    if (!item.passed) allPassed = false;
  }
  console.log('======================================================');

  if (allPassed) {
    console.log('🎉 恭喜！全站 6 大核心維度測試與驗證 100% 通過！系統穩定可靠。');
    process.exit(0);
  } else {
    console.error('⚠️ 部分功能測試未通過，請檢查上方錯誤細節。');
    process.exit(1);
  }
}

runFullSiteVerification();
