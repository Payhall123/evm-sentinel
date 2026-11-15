"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { createSession, destroySession } from "@/lib/session";

export type LoginFormState = { error?: string };

export async function loginAdminAction(_prev: LoginFormState | undefined, formData: FormData): Promise<LoginFormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  if (!admin) return { error: "Invalid credentials" };
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) return { error: "Invalid credentials" };

  await createSession({ role: "admin", sub: admin.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
  redirect("/admin");
}

export async function loginUserAction(_prev: LoginFormState | undefined, formData: FormData): Promise<LoginFormState> {
  const key = String(formData.get("key") || "").trim();
  const email = String(formData.get("email") || "").trim().toLowerCase();

  if (!key) return { error: "Access key is required" };

  const accessKey = await prisma.accessKey.findFirst({ where: { key, revokedAt: null } });
  if (!accessKey) return { error: "Invalid access key" };

  // Verify the provided identifier matches the key (optional binding email captured at creation)
  const accountEmail = accessKey.email || "";
  if (accountEmail && email && accountEmail !== email) {
    return { error: "This access key is not associated with that email" };
  }

  await createSession({ role: "user", sub: accessKey.id, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}