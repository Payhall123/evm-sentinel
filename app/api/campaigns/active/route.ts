import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { ensureDispatcherRunning } from "@/lib/dispatcher";
import { kickDispatcher } from "@/lib/dispatch-kick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The response is sent first, then the background tick keeps sending for up to
// Vercel's function limit. Leftover messages stay queued for the next tick.
export const maxDuration = 60;

// Feeds the live send toast. Returns the most recent campaign for the signed-in
// access key (active or most recently finished) so the client can show a live
// count/speed/progress bar and a brief completion state. Polling this endpoint
// also acts as a safety net that keeps the background dispatcher alive after a
// restart, even before any dashboard page has rendered.
export async function GET() {
  try {
    const session = await getSession();
    if (!session || session.role !== "user") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const accessKey = await prisma.accessKey.findFirst({
      where: { id: session.sub, revokedAt: null },
    });
    if (!accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const campaign = await prisma.campaign.findFirst({
      where: { accessKeyId: accessKey.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        subject: true,
        totalCount: true,
        sentCount: true,
        failedCount: true,
      },
    });

    if (campaign && (campaign.status === "queued" || campaign.status === "sending")) {
      // Serverless has no long-lived worker, so the open dashboard is what
      // drives the queue: after the poll response is flushed, push the next
      // batch. Locally the in-process interval already does this.
      if (process.env.VERCEL) {
        after(() => kickDispatcher({ timeBudgetMs: 45_000 }));
      } else {
        ensureDispatcherRunning();
      }
    }

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("[api/campaigns/active] Unexpected error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
