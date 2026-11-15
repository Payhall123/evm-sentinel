import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, type Tone } from "@/components/ui";
import { deliveryCountsByCampaign, emptyCounts, type SessionCounts } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const toneFor = (s: string): Tone =>
  s === "sent" ? "green" : s === "failed" ? "red" : s === "partial" ? "amber" : "cyan";

// Columns mirror the per-status breakdown the provider exposes, so a session's
// row reads like the mail server's own delivery table, with the app's own
// accepted/failed/queued split alongside it.
const COLUMNS: { key: keyof SessionCounts; label: string; tone?: string }[] = [
  { key: "delivered", label: "Delivered", tone: "text-emerald-400" },
  { key: "softFail", label: "Soft-fail", tone: "text-amber-400" },
  { key: "hardFail", label: "Hard-fail", tone: "text-red-400" },
  { key: "bounced", label: "Bounced", tone: "text-red-400" },
  { key: "held", label: "Held", tone: "text-cyan-400" },
  { key: "pending", label: "Pending", tone: "text-zinc-300" },
  { key: "failed", label: "Failed", tone: "text-red-300" },
  { key: "skipped", label: "Skipped", tone: "text-zinc-400" },
  { key: "queued", label: "Queued", tone: "text-cyan-300" },
];

function sum(counts: SessionCounts[]): SessionCounts {
  const t = emptyCounts();
  for (const c of counts) {
    for (const k of Object.keys(t) as (keyof SessionCounts)[]) t[k] += c[k];
  }
  return t;
}

function rateFor(c: SessionCounts): string {
  const reported = c.delivered + c.softFail + c.hardFail + c.bounced + c.held;
  if (reported === 0) return "—";
  return `${Math.round((c.delivered / reported) * 100)}%`;
}

export default async function AnalyticsPage() {
  const { accessKey } = await requireUser();

  const campaigns = await prisma.campaign.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      totalCount: true,
      createdAt: true,
      letter: { select: { name: true } },
      list: { select: { name: true } },
    },
  });

  const counts = await deliveryCountsByCampaign(campaigns.map((c) => c.id));
  const totals = sum(campaigns.map((c) => counts.get(c.id) ?? emptyCounts()));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Analytics</h1>
        <p className="text-sm text-zinc-500">
          Delivery breakdown for every send session. “Accepted” is what we handed to the mail
          server; the outcome columns are what it reported back.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Sessions" value={campaigns.length} tone="text-white" />
        <Stat label="Recipients" value={totals.total} tone="text-white" />
        <Stat label="Delivered" value={totals.delivered} tone="text-emerald-400" />
        <Stat label="Issues" value={totals.softFail + totals.hardFail + totals.bounced + totals.held} tone="text-amber-400" />
        <Stat label="Delivery rate" value={rateFor(totals)} tone="text-cyan-400" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr>
              <th className="sticky left-0 bg-zinc-900 px-4 py-3">Session</th>
              <th className="px-3 py-3 text-right">Total</th>
              <th className="px-3 py-3 text-right">Accepted</th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="px-3 py-3 text-right whitespace-nowrap">
                  {c.label}
                </th>
              ))}
              <th className="px-3 py-3 text-right">Rate</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {campaigns.map((c) => {
              const n = counts.get(c.id) ?? emptyCounts();
              return (
                <tr key={c.id} className="hover:bg-zinc-900/40">
                  <td className="sticky left-0 bg-zinc-950 px-4 py-2">
                    <p className="font-medium text-white">{c.letter?.name ?? "—"}</p>
                    <p className="text-xs text-zinc-500">
                      {c.list?.name} · {c.createdAt.toLocaleString()}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right text-zinc-300">{n.total}</td>
                  <td className="px-3 py-2 text-right text-cyan-400">{n.accepted}</td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} className={`px-3 py-2 text-right ${n[col.key] ? col.tone ?? "text-zinc-300" : "text-zinc-600"}`}>
                      {n[col.key]}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right text-zinc-400">{rateFor(n)}</td>
                  <td className="px-4 py-2 text-right">
                    <Badge tone={toneFor(c.status)}>{c.status}</Badge>
                  </td>
                </tr>
              );
            })}
            {campaigns.length > 0 && (
              <tr className="bg-zinc-900/60 font-medium">
                <td className="sticky left-0 bg-zinc-900/60 px-4 py-2 text-zinc-300">All sessions</td>
                <td className="px-3 py-2 text-right text-zinc-200">{totals.total}</td>
                <td className="px-3 py-2 text-right text-cyan-400">{totals.accepted}</td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className={`px-3 py-2 text-right ${col.tone ?? "text-zinc-300"}`}>
                    {totals[col.key]}
                  </td>
                ))}
                <td className="px-3 py-2 text-right text-zinc-300">{rateFor(totals)}</td>
                <td className="px-4 py-2" />
              </tr>
            )}
            {!campaigns.length && (
              <tr>
                <td colSpan={COLUMNS.length + 5} className="px-4 py-10 text-center text-sm text-zinc-500">
                  No sessions yet.{" "}
                  <Link href="/dashboard/campaigns/new" className="text-cyan-400 hover:underline">
                    Create a campaign
                  </Link>
                  .
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        “Pending” means the mail server accepted the message but has not reported an outcome yet
        (it can take a few minutes for retries). Rows link through to per-recipient detail on each
        campaign page.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-center">
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
      <p className="mt-1 text-xs text-zinc-500">{label}</p>
    </div>
  );
}
