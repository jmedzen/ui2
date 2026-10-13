import { NextResponse } from 'next/server';
import {
  HEAL_TASK,
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

    return NextResponse.json({
      status: 'active',
      isRunning: isScanLocked(),
      lastAutoHeal: dbInfo.last_auto_healed_at,
      totalCourses: dbInfo.total_courses,
      totalRepaired: dbInfo.total_repaired,
      recentLogs: readRecentLogs()
    });
  } catch (error: any) {
    console.error('[API/Health-Check] Error in GET handler:', error);
    return NextResponse.json({ error: 'Failed to read audit status' }, { status: 500 });
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

    console.log('[API/Health-Check] Triggering self-healing script: auto_heal_catalog.py in background...');
    appendLog('🚑 === 已觸發：全站自我巡檢與目錄自動修復 (pid guard active) ===');

    runTaskScript('auto_heal_catalog.py', 'AutoHeal');

    return NextResponse.json({
      message: 'Catalog audit & self-healing launched in background',
      status: 'started',
      running: HEAL_TASK,
      recentLogs: readRecentLogs()
    });
  } catch (error: any) {
    console.error('[API/Health-Check] Error in POST handler:', error);
    return NextResponse.json({ error: 'Failed to launch audit' }, { status: 500 });
  }
}
