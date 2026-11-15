import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";

// A tiny cross-instance mutex backed by Postgres. Vercel can invoke the same
// cron route more than once (retries, overlapping schedules, manual hits), and
// an in-process boolean is not enough to stop duplicate sends.
//
// The lock is deliberately leased: if a function dies without releasing it,
// another invocation can take over after `ttlMs`. The owner token ensures the
// late process cannot clear a newer invocation's lock.
export async function withJobLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const owner = randomUUID();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttlMs);

  // Create the row on first use. Concurrent inserts are harmless because the
  // primary key serialises them; one may throw and the retry below can proceed.
  try {
    await prisma.jobLock.upsert({
      where: { name },
      create: { name, owner: null, lockedUntil: null },
      update: {},
    });
  } catch {
    // Another invocation created it between our read and insert. The claim
    // update below is still the authoritative operation.
  }

  const claimed = await prisma.jobLock.updateMany({
    where: {
      name,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { owner, lockedUntil },
  });
  if (claimed.count === 0) return null;

  try {
    return await fn();
  } finally {
    await prisma.jobLock
      .updateMany({
        where: { name, owner },
        data: { owner: null, lockedUntil: null },
      })
      .catch(() => {
        // If the DB is unavailable, the lease expires on its own.
      });
  }
}
