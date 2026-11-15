import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";

export const requireAdmin = cache(async () => {
  const session = await getSession();
  if (!session || session.role !== "admin") redirect("/login");
  const admin = await prisma.adminUser.findUnique({ where: { id: session.sub } });
  if (!admin) redirect("/login");
  return admin;
});

export const requireUser = cache(async () => {
  const session = await getSession();
  if (!session || session.role !== "user") redirect("/login");
  const accessKey = await prisma.accessKey.findFirst({
    where: { id: session.sub, revokedAt: null },
    include: { smtpEndpoints: { orderBy: { createdAt: "asc" } } },
  });
  if (!accessKey) redirect("/login");
  return { session, accessKey };
});

export const currentAdmin = cache(async () => {
  const session = await getSession();
  if (!session || session.role !== "admin") return null;
  return prisma.adminUser.findUnique({ where: { id: session.sub } });
});