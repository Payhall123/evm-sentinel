import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card } from "@/components/ui";
import { deleteListAction } from "@/app/actions/contacts";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const { accessKey } = await requireUser();
  const lists = await prisma.contactList.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { contacts: true } } },
  });
  const total = lists.reduce((n, l) => n + l._count.contacts, 0);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Contacts</h1>
          <p className="text-sm text-zinc-500">{lists.length} list(s) · {total} contact(s) total</p>
        </div>
        <Link href="/dashboard/contacts/upload" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
          Upload CSV
        </Link>
      </div>

      <div className="space-y-3">
        {lists.map((l) => (
          <Card key={l.id} className="flex items-center justify-between">
            <div>
              <p className="font-medium text-white">{l.name}</p>
              <p className="text-sm text-zinc-500">{l._count.contacts} contacts</p>
            </div>
            <div className="flex items-center gap-3">
              <Link href={`/dashboard/contacts/${l.id}`} className="text-sm text-cyan-400 hover:underline">
                View
              </Link>
              <form action={deleteListAction.bind(null, l.id)}>
                <button className="text-sm text-red-400 hover:underline" type="submit">
                  Delete
                </button>
              </form>
            </div>
          </Card>
        ))}
        {!lists.length && (
          <p className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
            No contact lists yet. Upload a CSV to get started.
          </p>
        )}
      </div>
    </div>
  );
}