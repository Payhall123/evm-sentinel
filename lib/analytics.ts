import "server-only";

import { prisma } from "@/lib/db";

// Per-session ("campaign") analytics: the app's own send outcomes (did we hand
// each recipient to the transport?) plus the transport's reported delivery
// outcomes (what happened after that). Both are shown side by side because they
// answer different questions, and the delivery side can legitimately be empty
// for a while (or for transports that don't report back).
export type SessionCounts = {
  total: number;
  // App view
  queued: number;
  accepted: number; // handed to the transport ("sent")
  failed: number; // transport rejected before sending
  skipped: number; // suppressed / unsubscribed
  // Transport view (outcomes reported back by the provider)
  delivered: number;
  softFail: number;
  hardFail: number;
  bounced: number;
  held: number;
  pending: number; // accepted, but no outcome reported yet
};

export function emptyCounts(): SessionCounts {
  return {
    total: 0,
    queued: 0,
    accepted: 0,
    failed: 0,
    skipped: 0,
    delivered: 0,
    softFail: 0,
    hardFail: 0,
    bounced: 0,
    held: 0,
    pending: 0,
  };
}

const DELIVERY_KEY: Record<string, keyof SessionCounts> = {
  sent: "delivered",
  soft_fail: "softFail",
  hard_fail: "hardFail",
  bounced: "bounced",
  held: "held",
};

// Computes counts for many campaigns in two grouped queries (rather than one
// query per campaign), which keeps the analytics page fast even with a long
// campaign history.
export async function deliveryCountsByCampaign(
  campaignIds: string[],
): Promise<Map<string, SessionCounts>> {
  const out = new Map<string, SessionCounts>();
  if (!campaignIds.length) return out;
  for (const id of campaignIds) out.set(id, emptyCounts());

  const [statusRows, deliveryRows] = await Promise.all([
    prisma.message.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ["campaignId", "deliveryStatus"],
      where: { campaignId: { in: campaignIds }, deliveryStatus: { not: null } },
      _count: { _all: true },
    }),
  ]);

  for (const row of statusRows) {
    const counts = out.get(row.campaignId);
    if (!counts) continue;
    const n = row._count._all;
    counts.total += n;
    if (row.status === "queued") counts.queued += n;
    else if (row.status === "sent") counts.accepted += n;
    else if (row.status === "failed") counts.failed += n;
    else if (row.status === "skipped") counts.skipped += n;
  }

  for (const row of deliveryRows) {
    const counts = out.get(row.campaignId);
    if (!counts || !row.deliveryStatus) continue;
    const key = DELIVERY_KEY[row.deliveryStatus];
    if (key) (counts[key] as number) += row._count._all;
  }

  for (const counts of out.values()) {
    const reported =
      counts.delivered + counts.softFail + counts.hardFail + counts.bounced + counts.held;
    counts.pending = Math.max(0, counts.accepted - reported);
  }

  return out;
}

export async function deliveryCountsForCampaign(campaignId: string): Promise<SessionCounts> {
  const map = await deliveryCountsByCampaign([campaignId]);
  return map.get(campaignId) ?? emptyCounts();
}

// Human labels + display order shared by the analytics views.
export const DELIVERY_FIELDS: { key: keyof SessionCounts; label: string; tone: "green" | "amber" | "red" | "cyan" | "zinc" }[] = [
  { key: "delivered", label: "Delivered", tone: "green" },
  { key: "softFail", label: "Soft-failed", tone: "amber" },
  { key: "hardFail", label: "Hard-failed", tone: "red" },
  { key: "bounced", label: "Bounced", tone: "red" },
  { key: "held", label: "Held", tone: "cyan" },
  { key: "pending", label: "Pending", tone: "zinc" },
];
