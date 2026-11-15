import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { NewCampaignForm } from "@/components/new-campaign-form";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const { accessKey } = await requireUser();
  const [letters, lists, senders] = await Promise.all([
    prisma.letter.findMany({ where: { accessKeyId: accessKey.id }, orderBy: { createdAt: "desc" } }),
    prisma.contactList.findMany({
      where: { accessKeyId: accessKey.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { contacts: true } } },
    }),
    prisma.sender.findMany({ where: { accessKeyId: accessKey.id }, orderBy: { email: "asc" } }),
  ]);

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-semibold text-white">New campaign</h1>
      <NewCampaignForm
        domain={accessKey.domain} provider={accessKey.provider}
        letters={letters.map((l) => ({ id: l.id, name: l.name }))}
        lists={lists.map((l) => ({ id: l.id, name: l.name, count: l._count.contacts }))}
        senders={senders.map((s) => ({ id: s.id, name: s.name || "", email: s.email, replyTo: s.replyTo || "" }))}
      />
    </div>
  );
}
