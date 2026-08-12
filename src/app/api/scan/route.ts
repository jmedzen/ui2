import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

function getScannerLogPath(): string {
  const dataLogsDir = path.join(process.cwd(), 'data', 'logs');
  if (!fs.existsSync(dataLogsDir)) {
    fs.mkdirSync(dataLogsDir, { recursive: true });
  }
  const persistentPath = path.join(dataLogsDir, 'scanner.log');

  const legacyPaths = [
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
    const logPath = getScannerLogPath();
    let logContent = 'No logs available';
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
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
      dbInfo = {
        generated_at: data.generated_at || 'Unknown',
        total_courses: data.total_courses || 0
      };
    }

    return NextResponse.json({
      status: 'active',
      schedule: 'Web Trigger / Manual',
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: logContent
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    console.log('[API/Scan] Executing media scan script: scan_fayun.py...');
    const scriptPath = path.join(process.cwd(), 'scripts', 'scan_fayun.py');
    return new Promise<NextResponse>((resolve) => {
      exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);

        const logPath = getScannerLogPath();
        let logContent = stdout;
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

        if (error) {
          resolve(NextResponse.json({ error: error.message, stderr, recentLogs: logContent }, { status: 500 }));
        } else {
          resolve(NextResponse.json({
            message: 'Scan executed successfully',
            output: stdout,
            lastScan: dbInfo.generated_at,
            totalCourses: dbInfo.total_courses,
            recentLogs: logContent
          }));
        }
      });
    });
  } catch (error: any) {
    console.error('[API/Scan] Error in POST handler:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
