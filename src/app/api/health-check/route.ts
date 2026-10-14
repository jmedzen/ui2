import { NextResponse } from 'next/server';
import {
  HEAL_TASK,
  authorizeTaskRequest,
  acquireScanLock,
  isScanLocked,
  getScanLockInfo,
  appendLog,
  readRecentLogs,
  readRunResult,
  readDbInfo,
  runTaskScript
} from '@/lib/serverTasks';

/** Generates the id echoed back so the UI can detect THIS run completing. */
function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const dbInfo = readDbInfo();

    return NextResponse.json({
      status: 'active',
      isRunning: isScanLocked(),
      lockHolder: getScanLockInfo(),
      lastAutoHeal: dbInfo.last_auto_healed_at,
      totalCourses: dbInfo.total_courses,
      totalRepaired: dbInfo.total_repaired,
      lastRun: readRunResult(),
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

    const lock = acquireScanLock();
    if (!lock.ok) {
      // See /api/scan: an unwritable data volume is a 503, not a 409.
      if (lock.reason === 'unavailable') {
        return NextResponse.json(
          {
            error: `無法寫入任務鎖定檔，資料目錄可能不可寫（${lock.error}）`,
            status: 'unavailable',
            detail: lock.error
          },
          { status: 503 }
        );
      }
      const who = lock.holder ? `（程序 ${lock.holder.pid}，已執行 ${lock.holder.age}）` : '';
      return NextResponse.json(
        {
          error: `已有掃描或修復任務正在執行中${who}`,
          status: 'busy',
          lockHolder: lock.holder
        },
        { status: 409 }
      );
    }

    console.log('[API/Health-Check] Triggering self-healing script: auto_heal_catalog.py in background...');
    appendLog('🚑 === 已觸發：全站自我巡檢與目錄自動修復 (pid guard active) ===');

    const runId = newRunId();
    runTaskScript('auto_heal_catalog.py', 'AutoHeal', lock.token, runId);

    return NextResponse.json({
      message: 'Catalog audit & self-healing launched in background',
      status: 'started',
      runId,
      running: HEAL_TASK,
      recentLogs: readRecentLogs()
    });
  } catch (error: any) {
    console.error('[API/Health-Check] Error in POST handler:', error);
    return NextResponse.json({ error: 'Failed to launch audit' }, { status: 500 });
  }
}
