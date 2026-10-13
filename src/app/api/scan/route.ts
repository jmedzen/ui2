import { NextResponse } from 'next/server';
import { getCacheStats } from '@/lib/serverMediaCache';
import {
  SCAN_TASK,
  authorizeTaskRequest,
  acquireScanLock,
  isScanLocked,
  appendLog,
  readRecentLogs,
  readDbInfo,
  runTaskScript
} from '@/lib/serverTasks';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const dbInfo = readDbInfo();
    const cacheStats = getCacheStats();

    return NextResponse.json({
      status: 'active',
      schedule: 'Web Trigger / Manual',
      isRunning: isScanLocked(),
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: readRecentLogs(),
      cacheStats
    });
  } catch (error: any) {
    console.error('[API/Scan] Error in GET handler:', error);
    return NextResponse.json({ error: 'Failed to read scan status' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const auth = authorizeTaskRequest(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message }, { status: auth.status });
    }

    if (!acquireScanLock()) {
      return NextResponse.json(
        { error: 'A scan or repair task is already running', status: 'busy' },
        { status: 409 }
      );
    }

    console.log('[API/Scan] Triggering media scan script: scan_fayun.py in background...');
    appendLog(`🔄 === 已觸發：連線 fayun.org 執行媒體同步與掃描 (pid guard active) ===`);

    runTaskScript('scan_fayun.py', 'Scan');

    const dbInfo = readDbInfo();
    return NextResponse.json({
      message: 'Scan launched in background',
      status: 'started',
      running: SCAN_TASK,
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: readRecentLogs()
    });
  } catch (error: any) {
    console.error('[API/Scan] Error in POST handler:', error);
    return NextResponse.json({ error: 'Failed to launch scan' }, { status: 500 });
  }
}
