import { NextResponse } from 'next/server';
import { getCacheStatsAsync } from '@/lib/serverMediaCache';
import {
  SCAN_TASK,
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
    const cacheStats = await getCacheStatsAsync();
    // Logs and lock-holder details can contain internal paths, pids and host
    // names. Status/counts stay public so the portal and healthcheck work, but
    // the operational detail is only included for an authenticated admin or
    // automation token.
    const admin = getOptionalAdminAuth(request);

    return NextResponse.json({
      status: 'active',
      schedule: 'Web Trigger / Manual',
      isRunning: isScanLocked(),
      lockHolder: admin ? getScanLockInfoPublic() : undefined,
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: admin ? readRecentLogs() : undefined,
      logsRestricted: !admin,
      lastRun: readRunResult(),
      cacheStats
    }, { headers: NO_STORE });
  } catch (error: unknown) {
    console.error('[API/Scan] Error in GET handler:', error);
    return NextResponse.json({ error: 'Failed to read scan status' }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const auth = authorizeAdminRequest(request);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.message, code: auth.code }, { status: auth.status });
    }

    appendAdminAudit('admin_action', {
      action: 'scan',
      via: auth.via,
      ip: clientKeyFor(request),
      result: 'authorized'
    });

    const lock = acquireScanLock();
    if (!lock.ok) {
      // Distinguish "someone else is working" from "this container cannot write
      // its data volume". The old code collapsed both into a 409 that read
      // "already running", which sent the user chasing a phantom task.
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

    console.log('[API/Scan] Triggering media scan script: scan_fayun.py in background...');
    appendLog(`🔄 === 已觸發：連線 fayun.org 執行媒體同步與掃描 (pid guard active) ===`);

    const runId = newRunId();
    runTaskScript('scan_fayun.py', 'Scan', lock.token, runId);

    const dbInfo = readDbInfo();
    return NextResponse.json({
      message: 'Scan launched in background',
      status: 'started',
      runId,
      running: SCAN_TASK,
      lastScan: dbInfo.generated_at,
      totalCourses: dbInfo.total_courses,
      recentLogs: readRecentLogs()
    });
  } catch (error: unknown) {
    console.error('[API/Scan] Error in POST handler:', error);
    return NextResponse.json({ error: 'Failed to launch scan' }, { status: 500 });
  }
}
