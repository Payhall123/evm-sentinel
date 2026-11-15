import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, type Tone } from "@/components/ui";
import { removeCampaignAction } from "@/app/actions/campaigns";

export const dynamic = "force-dynamic";

const toneFor = (s: string): Tone =>
  s === "sent" ? "green" : s === "failed" ? "red" : s === "partial" ? "amber" : "cyan";

export default async function CampaignsPage() {
  const { accessKey } = await requireUser();
  const campaigns = await prisma.campaign.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
    include: { letter: { select: { name: true } }, list: { select: { name: true } } },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Campaigns</h1>
          <p className="text-sm text-zinc-500">Send a letter to a contact list.</p>
        </div>
        <Link href="/dashboard/campaigns/new" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
          New campaign
        </Link>
      </div>

      <div className="space-y-3">
        {campaigns.map((c) => (
          <Card key={c.id}>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-white">{c.letter.name}</p>
                <p className="text-sm text-zinc-500">
                  {c.list.name} · {c.totalCount} recipients · from {c.fromEmail || "auto-selected sender"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge tone={toneFor(c.status)}>{c.status}</Badge>
                <Link href={`/dashboard/campaigns/${c.id}`} className="text-sm text-cyan-400 hover:underline">
                  Details
                </Link>
                <form action={removeCampaignAction.bind(null, c.id)}>
                  <button className="text-sm text-red-400 hover:underline" type="submit">
                    Delete
                  </button>
                </form>
              </div>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full bg-cyan-500"
                style={{ width: `${c.totalCount ? Math.min(100, ((c.sentCount + c.failedCount) / c.totalCount) * 100) : 0}%` }}
              />
            </div>
            <p className="mt-1 text-right text-xs text-zinc-500">
              {c.sentCount} sent · {c.failedCount} failed
            </p>
          </Card>
        ))}
        {!campaigns.length && (
          <p className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
            No campaigns yet. Create your first send.
          </p>
        )}
      </div>
    </div>
  );
}