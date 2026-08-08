import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';

export async function GET() {
  try {
    const logPath = path.join(process.cwd(), 'scanner.log');
    let logContent = 'No logs available';
    if (fs.existsSync(logPath)) {
      const fullLog = fs.readFileSync(logPath, 'utf-8');
      const lines = fullLog.trim().split('\n');
      logContent = lines.slice(-20).join('\n');
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
      schedule: 'Web Trigger Only',
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
        if (error) {
          resolve(NextResponse.json({ error: error.message, stderr }, { status: 500 }));
        } else {
          resolve(NextResponse.json({ message: 'Scan executed successfully', output: stdout }));
        }
      });
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
