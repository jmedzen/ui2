import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getCacheStats } from '@/lib/serverMediaCache';

function getScannerLogPath(): string {
  const dataLogsDir = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'logs');
  if (!fs.existsSync(dataLogsDir)) {
    try {
      fs.mkdirSync(dataLogsDir, { recursive: true });
    } catch {}
  }
  return path.join(dataLogsDir, 'scanner.log');
}

export async function GET() {
  try {
    const logPath = getScannerLogPath();
    let logContent = 'No logs available';
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-500).join('\n');
    }

    const dataDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
    const srcDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');
    const dbPath = fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;
    let dbInfo = { generated_at: 'Unknown', total_courses: 0 };
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        dbInfo = {
          generated_at: data.generated_at || 'Unknown',
          total_courses: data.total_courses || 0
        };
      } catch {}
    }

    const cacheStats = getCacheStats();

    return NextResponse.json({
      status: 'active',
      schedule: 'Web Trigger / Manual',
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: logContent,
      cacheStats
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    console.log('[API/Scan] Triggering media scan script: scan_fayun.py in background...');
    const scriptPath = path.join(process.cwd(), 'scripts', 'scan_fayun.py');
    const logPath = getScannerLogPath();

    // Trigger non-blocking background execution
    exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
      if (stdout) console.log('[Scan]', stdout);
      if (stderr) console.error('[Scan Stderr]', stderr);
      if (error) console.error('[Scan Error]', error);
    });

    const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
    const startMsg = `[${timestamp}] 🔄 === 連線 fayun.org 執行媒體同步與掃描已於背景啟動 ===`;
    try {
      fs.appendFileSync(logPath, `\n${startMsg}\n`, 'utf-8');
    } catch {}

    let logContent = startMsg;
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-500).join('\n');
    }

    const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');
    const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
    const dbPath = fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;

    let dbInfo = { generated_at: 'Unknown', total_courses: 0 };
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        dbInfo = {
          generated_at: data.generated_at || 'Unknown',
          total_courses: data.total_courses || 0
        };
      } catch {}
    }

    return NextResponse.json({
      message: 'Scan launched in background',
      status: 'started',
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: logContent
    });
  } catch (error: any) {
    console.error('[API/Scan] Error in POST handler:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
