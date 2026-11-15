import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge } from "@/components/ui";
import { deleteLetterAction } from "@/app/actions/letters";

export const dynamic = "force-dynamic";

export default async function LettersPage() {
  const { accessKey } = await requireUser();
  const letters = await prisma.letter.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { campaigns: true } } },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Letters</h1>
          <p className="text-sm text-zinc-500">Reusable mail templates. You can have several.</p>
        </div>
        <Link href="/dashboard/letters/new" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
          New letter
        </Link>
      </div>

      <div className="space-y-3">
        {letters.map((l) => {
          const isPlainText = !l.htmlBody.trim() && !!l.plainText?.trim();
          return (
            <Card key={l.id} className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium text-white">{l.name}</p>
                  <Badge tone={isPlainText ? "zinc" : "cyan"}>{isPlainText ? "Plain text" : "HTML"}</Badge>
                </div>
                <p className="text-sm text-zinc-500 truncate max-w-xl">{l.subject}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-600">{l._count.campaigns} campaign(s)</span>
                <Link href={`/dashboard/letters/${l.id}/edit`} className="text-sm text-cyan-400 hover:underline">
                  Edit
                </Link>
                <form action={deleteLetterAction.bind(null, l.id)}>
                  <button className="text-sm text-red-400 hover:underline" type="submit">
                    Delete
                  </button>
                </form>
              </div>
            </Card>
          );
        })}
        {!letters.length && (
          <p className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
            No letters yet. Create your first one.
          </p>
        )}
      </div>
    </div>
  );
}