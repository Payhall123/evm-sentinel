import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
  const { accessKey } = await requireUser();
  const [senders, letters, lists, campaigns, sent, failed] = await Promise.all([
    prisma.sender.count({ where: { accessKeyId: accessKey.id } }),
    prisma.letter.count({ where: { accessKeyId: accessKey.id } }),
    prisma.contactList.count({ where: { accessKeyId: accessKey.id } }),
    prisma.campaign.count({ where: { accessKeyId: accessKey.id } }),
    prisma.message.count({ where: { campaign: { accessKeyId: accessKey.id }, status: "sent" } }),
    prisma.message.count({ where: { campaign: { accessKeyId: accessKey.id }, status: "failed" } }),
  ]);

  const row = (label: string, value: number, href: string) => (
    <Link href={href}>
      <Card className="transition-colors hover:border-zinc-700">
        <p className="text-3xl font-semibold text-white">{value}</p>
        <p className="mt-1 text-sm text-zinc-500">{label}</p>
      </Card>
    </Link>
  );

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold text-white">Overview</h1>
      <p className="mb-6 text-sm text-zinc-500">Welcome back. Here&apos;s how your mailbox looks.</p>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {row("From addresses", senders, "/dashboard/senders")}
        {row("Letters", letters, "/dashboard/letters")}
        {row("Contact lists", lists, "/dashboard/contacts")}
        {row("Campaigns", campaigns, "/dashboard/campaigns")}
        <div>
          <Card>
            <p className="text-3xl font-semibold text-emerald-400">{sent}</p>
            <p className="mt-1 text-sm text-zinc-500">Emails sent</p>
            <p className="mt-2 text-sm text-red-400">{failed} failed</p>
          </Card>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/dashboard/letters/new" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
          Create a letter
        </Link>
        <Link href="/dashboard/contacts" className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800">
          Upload contacts
        </Link>
        <Link href="/dashboard/campaigns/new" className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800">
          Start a campaign
        </Link>
      </div>
    </div>
  );
}