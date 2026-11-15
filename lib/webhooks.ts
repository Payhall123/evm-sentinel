import "server-only";

import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { appBaseUrl, createServerWebhook } from "@/lib/postal";

// Public endpoint Postal posts delivery events to (see
// app/api/webhooks/postal/route.ts).
export const POSTAL_WEBHOOK_PATH = "/api/webhooks/postal";

// Distinguishes the mail servers that can carry this key's mail. A key in
// "both" mode can send via the API server and via an attached SMTP mailbox,
// which may be two different servers, so we register the webhook on each.
function targetServers(key: {
  postalOrg: string | null;
  postalServer: string | null;
  smtpOrg: string | null;
  smtpServer: string | null;
}): { org: string; server: string }[] {
  const seen = new Set<string>();
  const out: { org: string; server: string }[] = [];
  for (const [org, server] of [
    [key.postalOrg, key.postalServer],
    [key.smtpOrg, key.smtpServer],
  ] as const) {
    if (!org || !server) continue;
    const k = `${org}/${server}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ org, server });
  }
  return out;
}

// Registers the delivery webhook for an access key's mail server(s), once. The
// URL carries a per-key secret so the public endpoint can attribute a callback
// to the right key without trusting the caller. Safe to call before every
// campaign: it returns immediately once a secret has been stored.
export async function ensureWebhookForAccessKey(accessKeyId: string): Promise<void> {
  const base = appBaseUrl();
  if (!base) return; // no public URL configured; callbacks could never arrive

  const accessKey = await prisma.accessKey.findUnique({ where: { id: accessKeyId } });
  if (!accessKey) return;
  if (accessKey.provider !== "postal") return; // Devner and SES expose no Postal delivery feed
  if (accessKey.postalWebhookSecret) return;
  if (accessKey.revokedAt) return;

  const servers = targetServers(accessKey);
  if (!servers.length) return;

  const secret = randomBytes(24).toString("hex");
  const url = `${base}${POSTAL_WEBHOOK_PATH}?k=${secret}`;

  let registered = 0;
  let lastId: string | null = null;
  for (const { org, server } of servers) {
    try {
      const { id } = await createServerWebhook(org, server, `evmsentinel delivery analytics`, url);
      registered += 1;
      lastId = id ?? lastId;
    } catch (e) {
      console.error(`[webhooks] could not register webhook on ${org}/${server}`, e);
    }
  }

  if (!registered) throw new Error("Postal: could not register the delivery webhook on any server");

  await prisma.accessKey.update({
    where: { id: accessKeyId },
    data: { postalWebhookSecret: secret, postalWebhookId: lastId, postalWebhookAt: new Date() },
  });
}
