import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

function getScannerLogPath(): string {
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const persistentPath = path.join(logsDir, 'scanner.log');
  const legacyPath = path.join(process.cwd(), 'scanner.log');

  if (fs.existsSync(legacyPath) && !fs.existsSync(persistentPath)) {
    try {
      fs.copyFileSync(legacyPath, persistentPath);
    } catch {}
  }
  if (fs.existsSync(persistentPath)) return persistentPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
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

    const dbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
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
    const scriptPath = path.join(process.cwd(), 'scripts', 'scan_fayun.py');
    return new Promise<NextResponse>((resolve) => {
      exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
        const logPath = getScannerLogPath();
        let logContent = stdout;
        if (fs.existsSync(logPath)) {
          const fullLog = fs.readFileSync(logPath, 'utf-8');
          const lines = fullLog.trim().split('\n');
          logContent = lines.slice(-500).join('\n');
        }

        const dbPath = path.join(process.cwd(), 'src', 'data', 'courses_db.json');
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
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
