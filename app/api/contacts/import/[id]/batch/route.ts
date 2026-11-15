import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BATCH = 1_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type IncomingContact = {
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session || session.role !== "user") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const accessKey = await prisma.accessKey.findFirst({
      where: { id: session.sub, revokedAt: null },
      select: { id: true },
    });
    if (!accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { id } = await params;
    const job = await prisma.importJob.findFirst({
      where: { id, accessKeyId: accessKey.id },
      select: { id: true, listId: true, status: true },
    });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (job.status === "done" || job.status === "failed") {
      return NextResponse.json({ error: "import already finished" }, { status: 409 });
    }

    const body = (await req.json().catch(() => null)) as { contacts?: unknown } | null;
    if (!Array.isArray(body?.contacts) || body.contacts.length === 0) {
      return NextResponse.json({ error: "No contacts in batch" }, { status: 400 });
    }
    if (body.contacts.length > MAX_BATCH) {
      return NextResponse.json(
        { error: `Batch is too large (max ${MAX_BATCH})` },
        { status: 413 },
      );
    }

    const seen = new Set<string>();
    const rows: { listId: string; email: string; firstName: string | null; lastName: string | null }[] = [];
    for (const raw of body.contacts as IncomingContact[]) {
      const email = String(raw?.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      rows.push({
        listId: job.listId,
        email,
        firstName: raw.firstName ? String(raw.firstName).slice(0, 200) : null,
        lastName: raw.lastName ? String(raw.lastName).slice(0, 200) : null,
      });
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: "No valid contacts in batch" }, { status: 400 });
    }

    const [created, updated] = await prisma.$transaction([
      prisma.contact.createMany({ data: rows }),
      prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "processing",
          processedCount: { increment: rows.length },
        },
        select: { processedCount: true, totalCount: true, skippedCount: true },
      }),
    ]);

    return NextResponse.json({
      inserted: created.count,
      processedCount: updated.processedCount,
      totalCount: updated.totalCount,
      skippedCount: updated.skippedCount,
    });
  } catch (error) {
    console.error("[api/contacts/import/:id/batch] unexpected error:", error);
    return NextResponse.json({ error: "Batch insert failed" }, { status: 500 });
  }
}
