import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db";

// RFC 8058 one-click unsubscribe. Every campaign message carries a
// List-Unsubscribe header pointing at a signed, per-contact URL; mail clients
// that support one-click POST it straight back without the reader visiting a
// page. Gmail and Yahoo both require this from bulk senders, and receivers weigh
// its absence heavily when scoring a message as spam.
//
// Two variables are required. Without them no header is emitted at all, so a
// half-configured deployment degrades to sending without the header rather than
// sending with a broken unsubscribe link.
const SECRET = process.env.UNSUBSCRIBE_SECRET?.trim() || "";
const BASE_URL = (process.env.UNSUBSCRIBE_BASE_URL?.trim() || "").replace(/\/+$/, "");

export function unsubscribeConfigured(): boolean {
  return SECRET.length > 0 && BASE_URL.length > 0;
}

// Addresses are compared lowercased so an opt-out cannot be side-stepped by
// changing the casing of the address on a later import.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The signature covers both ids, so a link minted for one access key cannot be
// replayed against another. The hex digest is URL-path safe.
function signatureFor(accessKeyId: string, contactId: string): string {
  return createHmac("sha256", SECRET).update(`${accessKeyId}.${contactId}`).digest("hex");
}

function verifySignature(accessKeyId: string, contactId: string, signature: string): boolean {
  if (!SECRET) return false;
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = Buffer.from(signatureFor(accessKeyId, contactId), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

// Returns "" when unsubscribe is not configured, which callers read as "send
// without the header" rather than as an error.
export function buildUnsubscribeUrl(accessKeyId: string, contactId: string): string {
  if (!unsubscribeConfigured()) return "";
  const signature = signatureFor(accessKeyId, contactId);
  return `${BASE_URL}/api/unsubscribe/${encodeURIComponent(contactId)}/${signature}`;
}

export type UnsubscribeOutcome =
  | { ok: true; email: string; already: boolean }
  | { ok: false; reason: "not_configured" | "not_found" | "bad_signature" };

// Idempotent: replaying the same link (one-click clients retry) reports
// already=true instead of erroring.
export async function unsubscribeContact(
  contactId: string,
  signature: string
): Promise<UnsubscribeOutcome> {
  if (!unsubscribeConfigured()) return { ok: false, reason: "not_configured" };

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      email: true,
      unsubscribedAt: true,
      list: { select: { accessKeyId: true } },
    },
  });
  if (!contact) return { ok: false, reason: "not_found" };

  const accessKeyId = contact.list.accessKeyId;
  if (!verifySignature(accessKeyId, contact.id, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  const email = normalizeEmail(contact.email);

  // Both writes in one transaction so a partial failure can never leave a
  // suppression row without the contact flag, or the reverse.
  await prisma.$transaction([
    prisma.suppression.upsert({
      where: { accessKeyId_email: { accessKeyId, email } },
      create: { accessKeyId, email, reason: "unsubscribed" },
      update: {},
    }),
    prisma.contact.update({
      where: { id: contact.id },
      data: { unsubscribedAt: contact.unsubscribedAt ?? new Date() },
    }),
  ]);

  return { ok: true, email, already: contact.unsubscribedAt !== null };
}

// Batch variant: one query for the whole dispatch batch rather than one per
// message, which matters because the dispatcher loops every queued message.
export async function suppressedEmails(accessKeyId: string): Promise<Set<string>> {
  const rows = await prisma.suppression.findMany({
    where: { accessKeyId },
    select: { email: true },
  });
  return new Set(rows.map((r) => normalizeEmail(r.email)));
}
