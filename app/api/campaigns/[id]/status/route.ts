import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { deliveryCountsForCampaign } from "@/lib/analytics";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session || session.role !== "user") {
      console.warn("[api/campaigns/status] Unauthorized access attempt");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const accessKey = await prisma.accessKey.findFirst({
      where: { id: session.sub, revokedAt: null },
    });
    if (!accessKey) {
      console.warn("[api/campaigns/status] No active access key for session");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Validate that id is provided
    if (!id || id.trim() === "") {
      console.warn("[api/campaigns/status] Missing campaign ID");
      return NextResponse.json({ error: "campaign ID is required" }, { status: 400 });
    }

    const campaign = await prisma.campaign.findFirst({
      where: { id, accessKeyId: accessKey.id }
    });

    if (!campaign) {
      console.warn(`[api/campaigns/status] Campaign not found or access denied: ${id}`);
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const latest = await prisma.message.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        email: true,
        status: true,
        deliveryStatus: true,
        deliveryDetail: true,
        deliveryOutput: true,
        deliveryUpdatedAt: true,
        sentAt: true,
        contact: { select: { firstName: true } },
      },
    });

    const delivery = await deliveryCountsForCampaign(id);

    // Log successful request in development
    if (process.env.NODE_ENV !== "production") {
      console.info(`[api/campaigns/status] Retrieved status for campaign ${id}`);
    }

    return NextResponse.json({
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      status: campaign.status,
      error: campaign.error,
      delivery,
      latest,
    });
  } catch (error) {
    console.error("[api/campaigns/status] Unexpected error:", error);
    return NextResponse.json(
      { error: "internal server error" },
      { status: 500 }
    );
  }
}