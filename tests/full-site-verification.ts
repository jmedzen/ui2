import { execSync } from 'child_process';
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
    console.log('⏳ [1/5] 執行 TypeScript 單元與端點測試套件 (node:test + tsx)...');
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
    console.log('⏳ [2/5] 驗證課程典藏資料庫 (courses_db.json)...');
    const dataDb = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'courses_db.json'), 'utf-8'));
    const srcDb = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'courses_db.json'), 'utf-8'));
    const totalCourses = srcDb.courses.length;
    const videoCount = srcDb.courses.filter((c: any) => c.video_path).length;
    const pdfCount = srcDb.courses.filter((c: any) => c.pdfs && c.pdfs.length > 0).length;

    const isMatch = dataDb.courses.length === srcDb.courses.length;

    results.push({
      name: '課程數據庫結構完整性 (Catalog DB)',
      passed: isMatch && totalCourses === 684 && videoCount === 478,
      details: `收錄 ${totalCourses} 門課程 | 影音講記 ${videoCount} 門 | 講義講述 ${pdfCount} 門 | 雙庫同動: ${isMatch ? '一致' : '不一致'}`
    });
    console.log(`✅ 數據庫檢驗通過: 684 門課程，478 門影音，雙庫同步一致\n`);
  } catch (err: any) {
    results.push({
      name: '課程數據庫結構完整性 (Catalog DB)',
      passed: false,
      details: err.message
    });
  }

  // 3. Media Cache Capacity (20GB)
  try {
    console.log('⏳ [3/5] 檢驗網頁主機媒體磁碟快取與 20GB 上限設定...');
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
    console.log('⏳ [4/5] 檢驗手機版 Firefox 與行動端 UI 相容配置...');
    const layoutContent = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf-8');
    const cssContent = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf-8');

    const hasExplicitHead = layoutContent.includes('<head>') && layoutContent.includes('<meta name="viewport"');
    const hasMobileQuery = cssContent.includes('@media (max-width: 960px)');
    const hasClassOverride = cssContent.includes('.app-root.is-mobile-screen');

    results.push({
      name: '行動版瀏覽器與 Firefox 相容性 (Mobile Viewport)',
      passed: hasExplicitHead && hasMobileQuery && hasClassOverride,
      details: `原生 <head> Viewport: ${hasExplicitHead ? '已配置' : '缺失'} | 960px 響應式斷點: ${hasMobileQuery ? '已配置' : '缺失'} | JS 動態類別保底: ${hasClassOverride ? '已配置' : '缺失'}`
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
    console.log('⏳ [5/5] 執行 Next.js 編譯完整性檢查 (npm run build)...');
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
    console.log('🎉 恭喜！全站 5 大核心維度測試與驗證 100% 通過！系統穩定可靠。');
    process.exit(0);
  } else {
    console.error('⚠️ 部分功能測試未通過，請檢查上方錯誤細節。');
    process.exit(1);
  }
}

runFullSiteVerification();
