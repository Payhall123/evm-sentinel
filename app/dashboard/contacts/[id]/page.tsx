import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Button, Input } from "@/components/ui";
import { Pagination } from "@/components/pagination";
import { PAGE_SIZE, firstParam, pageCountFor, pageFromParam } from "@/lib/pagination";

export const dynamic = "force-dynamic";

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { accessKey } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const query = firstParam(sp.q).trim().slice(0, 200);

  const list = await prisma.contactList.findFirst({
    where: { id, accessKeyId: accessKey.id },
    select: { id: true, name: true },
  });
  if (!list) notFound();

  const where: Prisma.ContactWhereInput = {
    listId: list.id,
    ...(query
      ? {
          OR: [
            { email: { contains: query, mode: "insensitive" } },
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const total = await prisma.contact.count({ where });
  const pageCount = pageCountFor(total);
  const page = pageFromParam(sp.page, pageCount);
  const contacts = await prisma.contact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const start = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, total);
  const hrefForPage = (nextPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    return `/dashboard/contacts/${list.id}${qs ? `?${qs}` : ""}`;
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-white">{list.name}</h1>
        <Link href="/dashboard/contacts" className="text-sm text-cyan-400 hover:underline">
          Back to lists
        </Link>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        {query ? `${total.toLocaleString()} matching contact(s)` : `${total.toLocaleString()} contact(s)`}
        {total > 0 ? ` · showing ${start.toLocaleString()}–${end.toLocaleString()}` : ""}
      </p>

      <form
        method="get"
        action={`/dashboard/contacts/${list.id}`}
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <Input
          key={query}
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search email, first name or last name..."
          className="sm:max-w-sm"
        />
        <div className="flex items-center gap-3">
          <Button type="submit">Search</Button>
          {query && (
            <Link href={`/dashboard/contacts/${list.id}`} className="text-sm text-zinc-400 hover:text-white">
              Clear
            </Link>
          )}
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">First name</th>
              <th className="px-4 py-3">Last name</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <td className="px-4 py-2 text-zinc-200">{contact.email}</td>
                <td className="px-4 py-2 text-zinc-400">{contact.firstName || "—"}</td>
                <td className="px-4 py-2 text-zinc-400">{contact.lastName || "—"}</td>
              </tr>
            ))}
            {!contacts.length && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-zinc-500">
                  {query ? `No contacts match “${query}”.` : "This list is empty."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} hrefForPage={hrefForPage} />
    </div>
  );
}
