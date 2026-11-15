import "server-only";

import { runDispatcherTick } from "@/lib/dispatcher";
import { withJobLock } from "@/lib/job-lock";

// Runs a dispatcher tick from inside an already-authenticated request (a server
// action or the dashboard's status poll) instead of waiting for the scheduler.
// This matters on Vercel Hobby, where the platform cron can only run once a day
// and an external scheduler is not always reliable: the user opening the
// dashboard is then what keeps the queue moving.
//
// The work is done under the same cross-instance lease as /api/cron/dispatch, so
// a dashboard kick and a cron run never send the same batch twice. A short
// in-process throttle keeps the once-a-second status poll from starting a new
// tick while the previous one is still going.
const LOCK_NAME = "campaign-dispatcher";
const LOCK_TTL_MS = 5 * 60 * 1000;

type KickState = { lastKickAt: number };

const g = globalThis as unknown as { evmsDispatchKick?: KickState };

function lastKickAt(): number {
  return (g.evmsDispatchKick ??= { lastKickAt: 0 }).lastKickAt;
}

export async function kickDispatcher(options: { timeBudgetMs?: number; minIntervalMs?: number } = {}): Promise<void> {
  const minIntervalMs = options.minIntervalMs ?? 5_000;
  if (Date.now() - lastKickAt() < minIntervalMs) return;
  g.evmsDispatchKick = { lastKickAt: Date.now() };

  try {
    await withJobLock(LOCK_NAME, LOCK_TTL_MS, () =>
      runDispatcherTick({ timeBudgetMs: options.timeBudgetMs ?? 45_000 }),
    );
  } catch (e) {
    // Never let a background send break the request that triggered it.
    console.error("[dispatcher] background kick failed", e);
  }
}
