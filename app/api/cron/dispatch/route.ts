import { NextResponse } from "next/server";

import { runDispatcherTick } from "@/lib/dispatcher";
import { withJobLock } from "@/lib/job-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep this comfortably below the Vercel plan limit. The dispatcher also stops
// between messages using DISPATCH_TIME_BUDGET_MS.
export const maxDuration = 60;

const LOCK_NAME = "campaign-dispatcher";
const LOCK_TTL_MS = 5 * 60 * 1000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Local development / self-hosted: no cron secret means the route is open,
    // matching the rest of the app's local-only defaults. In production the
    // secret is required so a public caller cannot drain the queue.
    return process.env.NODE_ENV !== "production";
  }
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  // Also accept the query form for manual runs from a browser/curl.
  return new URL(req.url).searchParams.get("secret") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await withJobLock(LOCK_NAME, LOCK_TTL_MS, () =>
      runDispatcherTick({ timeBudgetMs: 50_000 }),
    );
    if (!result) {
      return NextResponse.json({ ok: true, skipped: "locked" });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[api/cron/dispatch] unexpected error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
