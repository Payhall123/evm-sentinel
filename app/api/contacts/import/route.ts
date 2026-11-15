import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreateBody = {
  listId?: unknown;
  fileCount?: unknown;
  totalBytes?: unknown;
  totalCount?: unknown;
  skippedCount?: unknown;
  errors?: unknown;
};

function integer(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The browser parses files and creates the job once it knows how many contacts
// were found. Contacts are then POSTed in small batches to
// /api/contacts/import/[id]/batch, which keeps every request well under
// Vercel's body limit and avoids writing uploads to ephemeral local disk.
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session || session.role !== "user") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const accessKey = await prisma.accessKey.findFirst({
      where: { id: session.sub, revokedAt: null },
      select: { id: true },
    });
    if (!accessKey) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as CreateBody | null;
    if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const listId = String(body.listId || "");
    if (!listId) return NextResponse.json({ error: "Choose a list" }, { status: 400 });

    const list = await prisma.contactList.findFirst({
      where: { id: listId, accessKeyId: accessKey.id },
      select: { id: true },
    });
    if (!list) return NextResponse.json({ error: "List not found" }, { status: 404 });

    const fileCount = integer(body.fileCount);
    const totalBytes = integer(body.totalBytes);
    const totalCount = integer(body.totalCount);
    const skippedCount = integer(body.skippedCount);
    const error = typeof body.errors === "string" ? body.errors.slice(0, 4_000) || null : null;

    if (totalCount === 0) {
      return NextResponse.json(
        { error: "No valid contacts found in the selected file(s)." },
        { status: 400 },
      );
    }

    const job = await prisma.importJob.create({
      data: {
        accessKeyId: accessKey.id,
        listId: list.id,
        status: "processing",
        files: [],
        fileCount,
        totalBytes,
        totalCount,
        skippedCount,
        error,
        startedAt: new Date(),
      },
      select: { id: true },
    });

    return NextResponse.json({
      job: {
        id: job.id,
        fileCount,
        totalBytes,
        totalCount,
        skippedCount,
      },
      large: totalBytes > 1024 * 1024,
    });
  } catch (error) {
    console.error("[api/contacts/import] unexpected error:", error);
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
  }
}
