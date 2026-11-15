import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { deleteSenderAction } from "@/app/actions/letters";
import { SenderForm } from "@/components/sender-form";

export const dynamic = "force-dynamic";

export default async function SendersPage() {
  const { accessKey } = await requireUser();
  const senders = await prisma.sender.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold text-white">From addresses</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Add the addresses you send from. All must be on <span className="text-cyan-300">@{accessKey.domain}</span>. You can pick one per campaign plus a reply-to.
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          {senders.map((s) => (
            <Card key={s.id} className="flex items-center justify-between">
              <div>
                <p className="font-medium text-white">{s.name || s.email}</p>
                <p className="text-sm text-zinc-500">
                  {s.email} {s.replyTo ? `· reply-to ${s.replyTo}` : ""}
                </p>
              </div>
              <form action={deleteSenderAction.bind(null, s.id)}>
                <button className="text-sm text-red-400 hover:underline" type="submit">
                  Delete
                </button>
              </form>
            </Card>
          ))}
          {!senders.length && (
            <Card className="text-center text-sm text-zinc-500">No from addresses yet. Add the first one.</Card>
          )}
        </div>

        <SenderForm domain={accessKey.domain} />
      </div>
    </div>
  );
}