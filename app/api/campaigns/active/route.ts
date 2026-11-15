import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { ensureDispatcherRunning } from "@/lib/dispatcher";

export const dynamic = "force-dynamic";

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

    ensureDispatcherRunning();

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

    return NextResponse.json({ campaign });
  } catch (error) {
    console.error("[api/campaigns/active] Unexpected error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
