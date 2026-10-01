import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

function getAutoHealLogPath(): string {
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
    const logPath = getAutoHealLogPath();
    let logContent = 'No audit logs available';
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-500).join('\n');
    }

    const dataDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'courses_db.json');
    const srcDbPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src', 'data', 'courses_db.json');
    const dbPath = fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;
    let dbInfo = { generated_at: 'Unknown', last_auto_healed_at: 'Never', total_courses: 0, total_repaired: 0 };
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        dbInfo = {
          generated_at: data.generated_at || 'Unknown',
          last_auto_healed_at: data.last_auto_healed_at || 'Never',
          total_courses: data.total_courses || 0,
          total_repaired: data.total_repaired_courses || 0
        };
      } catch {}
    }

    return NextResponse.json({
      status: 'active',
      lastAutoHeal: dbInfo.last_auto_healed_at,
      totalCourses: dbInfo.total_courses,
      totalRepaired: dbInfo.total_repaired,
      recentLogs: logContent
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    console.log('[API/Health-Check] Triggering self-healing script: auto_heal_catalog.py in background...');
    const scriptPath = path.join(process.cwd(), 'scripts', 'auto_heal_catalog.py');
    const logPath = getAutoHealLogPath();

    // Trigger non-blocking background execution
    exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
      if (stdout) console.log('[AutoHeal]', stdout);
      if (stderr) console.error('[AutoHeal Stderr]', stderr);
      if (error) console.error('[AutoHeal Error]', error);
    });

    const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
    const startMsg = `[${timestamp}] 🚑 === 全站自我巡檢與目錄自動修復已於背景啟動 ===`;
    try {
      fs.appendFileSync(logPath, `\n${startMsg}\n`, 'utf-8');
    } catch {}

    let logContent = startMsg;
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-500).join('\n');
    }

    return NextResponse.json({
      message: 'Catalog audit & self-healing launched in background',
      status: 'started',
      recentLogs: logContent
    });
  } catch (error: any) {
    console.error('[API/Health-Check] Error in POST handler:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
