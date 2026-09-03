import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

function getAutoHealLogPath(): string {
  const dataLogsDir = path.join(process.cwd(), 'data', 'logs');
  if (!fs.existsSync(dataLogsDir)) {
    fs.mkdirSync(dataLogsDir, { recursive: true });
  }
  const persistentPath = path.join(dataLogsDir, 'scanner.log');

  const legacyPaths = [
    path.join(process.cwd(), 'data', 'logs', 'auto_heal.log'),
    path.join(process.cwd(), 'logs', 'scanner.log'),
    path.join(process.cwd(), 'scanner.log')
  ];

  for (const oldPath of legacyPaths) {
    if (fs.existsSync(oldPath) && !fs.existsSync(persistentPath)) {
      try {
        fs.copyFileSync(oldPath, persistentPath);
        break;
      } catch {}
    }
  }

  return persistentPath;
}

export async function GET() {
  try {
    const logPath = getAutoHealLogPath();
    let logContent = 'No audit logs available';
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-200).join('\n');
    }

    const dataDbPath = path.join(process.cwd(), 'data', 'courses_db.json');
    const srcDbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
    const dbPath = fs.existsSync(dataDbPath) ? dataDbPath : srcDbPath;
    let dbInfo = { generated_at: 'Unknown', last_auto_healed_at: 'Never', total_courses: 0, total_repaired: 0 };
    if (fs.existsSync(dbPath)) {
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
      dbInfo = {
        generated_at: data.generated_at || 'Unknown',
        last_auto_healed_at: data.last_auto_healed_at || 'Never',
        total_courses: data.total_courses || 0,
        total_repaired: data.total_repaired_courses || 0
      };
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
    console.log('[API/Health-Check] Executing self-healing script: auto_heal_catalog.py...');
    const scriptPath = path.join(process.cwd(), 'scripts', 'auto_heal_catalog.py');
    return new Promise<NextResponse>((resolve) => {
      exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);

        const logPath = getAutoHealLogPath();
        let logContent = stdout;
        if (fs.existsSync(logPath)) {
          const fullLog = fs.readFileSync(logPath, 'utf-8');
          const lines = fullLog.trim().split('\n');
          logContent = lines.slice(-500).join('\n');
        }

        if (error) {
          resolve(NextResponse.json({ error: error.message, stderr, recentLogs: logContent }, { status: 500 }));
        } else {
          resolve(NextResponse.json({
            message: 'Catalog audit & self-healing complete',
            output: stdout,
            recentLogs: logContent
          }));
        }
      });
    });
  } catch (error: any) {
    console.error('[API/Health-Check] Error in POST handler:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
