import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge } from "@/components/ui";
import Link from "next/link";

export default async function AdminOverviewPage() {
  await requireAdmin();
  const [keyCount, activeCount, campaigns, totalSent, totalFailed, letters, recentKeys] = await Promise.all([
    prisma.accessKey.count(),
    prisma.accessKey.count({ where: { status: "active" } }),
    prisma.campaign.count(),
    prisma.message.count({ where: { status: "sent" } }),
    prisma.message.count({ where: { status: "failed" } }),
    prisma.letter.count(),
    prisma.accessKey.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
  ]);

  const stat = (label: string, value: number | string) => (
    <Card className="text-center">
      <p className="text-3xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-sm text-zinc-500">{label}</p>
    </Card>
  );

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-white">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stat("Access keys", keyCount)}
        {stat("Active", activeCount)}
        {stat("Campaigns", campaigns)}
        {stat("Messages sent", totalSent)}
        {stat("Emails failed", totalFailed)}
        {stat("Letters", letters)}
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-white">Recent access keys</h2>
          <Link href="/admin/keys" className="text-sm text-cyan-400 hover:underline">View all →</Link>
        </div>
        {recentKeys.length ? (
          <div className="space-y-2">
            {recentKeys.map((k) => (
              <Card key={k.id} className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-white">{k.name}</p>
                  <p className="text-xs text-zinc-500">{k.domain}</p>
                </div>
                <Badge tone={k.status === "active" ? "green" : k.status === "revoked" ? "red" : k.status === "dns_pending" ? "amber" : "cyan"}>
                  {k.status}
                </Badge>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No access keys yet.</p>
        )}
      </div>
    </div>
  );
}