import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STALE_AFTER_MS = 30 * 60 * 1000;

async function requireAccessKey() {
  const session = await getSession();
  if (!session || session.role !== "user") return null;
  return prisma.accessKey.findFirst({
    where: { id: session.sub, revokedAt: null },
    select: { id: true },
  });
}

// Polled by the upload form while a batched import runs. Returns live progress so
// the toast can show how many contacts have been written and how far along it is.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const accessKey = await requireAccessKey();
    if (!accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { id } = await params;
    let job = await prisma.importJob.findFirst({
      where: { id, accessKeyId: accessKey.id },
      select: {
        id: true,
        status: true,
        fileCount: true,
        totalBytes: true,
        totalCount: true,
        processedCount: true,
        skippedCount: true,
        error: true,
        startedAt: true,
      },
    });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    // If the browser was closed mid-import, the job would otherwise stay
    // "processing" forever. Mark abandoned jobs failed so the UI can move on.
    if (
      job.status === "processing" &&
      job.startedAt &&
      Date.now() - job.startedAt.getTime() > STALE_AFTER_MS
    ) {
      const updated = await prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          error: "Import was interrupted. Please upload the file again.",
          finishedAt: new Date(),
        },
        select: {
          id: true,
          status: true,
          fileCount: true,
          totalBytes: true,
          totalCount: true,
          processedCount: true,
          skippedCount: true,
          error: true,
        },
      });
      job = { ...updated, startedAt: job.startedAt };
    }

    return NextResponse.json({
      id: job.id,
      status: job.status,
      fileCount: job.fileCount,
      totalBytes: job.totalBytes,
      totalCount: job.totalCount,
      processedCount: job.processedCount,
      skippedCount: job.skippedCount,
      error: job.error,
    });
  } catch (error) {
    console.error("[api/contacts/import/:id] unexpected error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}

// Called by the client after the last batch (or after a failed batch) so the
// job reaches a terminal state without relying on a background worker.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const accessKey = await requireAccessKey();
    if (!accessKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as
      | { status?: unknown; error?: unknown }
      | null;
    const status = body?.status === "done" || body?.status === "failed" ? body.status : null;
    if (!status) return NextResponse.json({ error: "invalid status" }, { status: 400 });

    const job = await prisma.importJob.findFirst({
      where: { id, accessKeyId: accessKey.id },
      select: { id: true, error: true },
    });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });

    const message =
      status === "failed"
        ? String(body?.error || job.error || "Import failed").slice(0, 4_000)
        : job.error;

    await prisma.importJob.update({
      where: { id: job.id },
      data: { status, error: message, finishedAt: new Date() },
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.error("[api/contacts/import/:id] unexpected error:", error);
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}
