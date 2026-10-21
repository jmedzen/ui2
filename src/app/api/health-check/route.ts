import { NextResponse } from 'next/server';
import {
  HEAL_TASK,
  acquireScanLock,
  isScanLocked,
  getScanLockInfoPublic,
  stripLockToken,
  appendLog,
  readRecentLogs,
  readRunResult,
  readDbInfo,
  runTaskScript
} from '@/lib/serverTasks';
import { authorizeAdminRequest, getOptionalAdminAuth } from '@/lib/adminAuth';
import { appendAdminAudit } from '@/lib/adminAudit';
import { clientKeyFor } from '@/lib/clientIp';

/**
 * These endpoints report live process state (a lock file, a log tail, a run
 * record). They are dynamic, but a GET with no cache directive at all is still
 * eligible for heuristic caching in some intermediaries, which would leave the
 * UI polling a frozen body. Being explicit removes the ambiguity.
 */
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

/** Generates the id echoed back so the UI can detect THIS run completing. */
function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const dbInfo = readDbInfo();
    // See /api/scan: public status, admin-only operational detail.
    const admin = getOptionalAdminAuth(request);

    return NextResponse.json({
      status: 'active',
      isRunning: isScanLocked(),
      lockHolder: admin ? getScanLockInfoPublic() : undefined,
      lastAutoHeal: dbInfo.last_auto_healed_at,
      totalCourses: dbInfo.total_courses,
      totalRepaired: dbInfo.total_repaired,
      lastRun: readRunResult(),
      recentLogs: admin ? readRecentLogs() : undefined,
      logsRestricted: !admin
    }, { headers: NO_STORE });
  } catch (error: unknown) {
    console.error('[API/Health-Check] Error in GET handler:', error);
    return NextResponse.json({ error: 'Failed to read audit status' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const auth = authorizeAdminRequest(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message, code: auth.code }, { status: auth.status });
    }

    appendAdminAudit('admin_action', {
      action: 'heal',
      via: auth.via,
      ip: clientKeyFor(request),
      result: 'authorized'
    });

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
      // `lock.holder` carries the ownership token; never return it over HTTP.
      const who = lock.holder ? `（程序 ${lock.holder.pid}，已執行 ${lock.holder.age}）` : '';
      return NextResponse.json(
        {
          error: `已有掃描或修復任務正在執行中${who}`,
          status: 'busy',
          lockHolder: lock.holder ? stripLockToken(lock.holder) : null
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
  } catch (error: unknown) {
    console.error('[API/Health-Check] Error in POST handler:', error);
    return NextResponse.json({ error: 'Failed to launch audit' }, { status: 500 });
  }
}
