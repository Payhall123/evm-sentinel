import "server-only";

import { stripMessageId } from "@/lib/delivery";

// Mailgun transport. Each access key stores its own API key and sending domain,
// so one EVM Sentinel deployment can front many Mailgun accounts. The domain is
// the Mailgun domain used in the API path (a sandbox domain is valid).
//
// Mailgun authenticates with HTTP Basic auth: username "api", password = API
// key. Messages are submitted as application/x-www-form-urlencoded to
// POST <base>/v3/<domain>/messages and the response carries the Mailgun message
// id used to correlate delivery events.
// https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages

const DEFAULT_MAILGUN_API_BASE = "https://api.mailgun.net";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

// The delivery outcomes EVM Sentinel surfaces for Mailgun. `permanent_fail`
// and `temporary_fail` both arrive as a "failed" event, distinguished by the
// event's severity field.
const MAILGUN_WEBHOOK_EVENTS = ["delivered", "permanent_fail", "temporary_fail", "complained"] as const;

export type MailgunSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Mailgun ids are normally surrounded by angle brackets. Store the stripped
  // form in correlationId so future webhook matching is consistent with the
  // other transports.
  perRecipientRef: Record<string, string>;
};

type MailgunResponse = {
  id?: string;
  message?: string;
  error?: string;
};

export function normalizeMailgunApiBase(value?: string | null): string {
  const raw = (value || process.env.MAILGUN_API_BASE || DEFAULT_MAILGUN_API_BASE)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v3$/i, "");
  if (!raw) throw new Error("Mailgun API base URL is missing");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Mailgun API base URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Mailgun API base URL must start with https:// or http://");
  }
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MailgunWebhookList = {
  webhooks?: Record<string, { urls?: string[] }>;
};

// Registers the EVM Sentinel callback on a Mailgun domain. The endpoint is
// idempotent: existing URLs are read first and only missing event types are
// created, so a retry after a partial failure does not pile up duplicates.
export async function ensureMailgunWebhooks(
  credentials: { apiKey: string; domain: string; apiBase?: string | null },
  webhookUrl: string,
): Promise<boolean> {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey) throw new Error("Mailgun API key is missing");
  const domain = credentials.domain.trim().replace(/^@/, "");
  if (!domain) throw new Error("Mailgun sending domain is missing");
  if (!webhookUrl) throw new Error("Mailgun webhook URL is missing");

  const apiBase = normalizeMailgunApiBase(credentials.apiBase);
  const authorization = `Basic ${Buffer.from(`api:${apiKey}`, "utf8").toString("base64")}`;
  const listEndpoint = `${apiBase}/v3/domains/${encodeURIComponent(domain)}/webhooks`;

  const listRes = await fetch(listEndpoint, {
    headers: { Authorization: authorization },
  });
  if (!listRes.ok) {
    const text = await listRes.text();
    throw new Error(`Mailgun webhook list failed (${listRes.status}): ${text || listRes.statusText}`);
  }
  const list = (await listRes.json()) as MailgunWebhookList;
  const existing = list.webhooks || {};
  const missing = MAILGUN_WEBHOOK_EVENTS.filter(
    (event) => !existing[event]?.urls?.includes(webhookUrl),
  );
  if (!missing.length) return true;

  const body = new URLSearchParams();
  body.set("url", webhookUrl);
  for (const event of missing) body.append("event_types", event);
  const createRes = await fetch(`${apiBase}/v4/domains/${encodeURIComponent(domain)}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Mailgun webhook registration failed (${createRes.status}): ${text || createRes.statusText}`);
  }
  return true;
}

export async function sendViaMailgun(
  credentials: { apiKey: string; domain: string; apiBase?: string | null },
  params: {
    to: string[];
    from: string;
    fromName?: string | null;
    replyTo?: string | null;
    subject: string;
    html?: string | null;
    text?: string | null;
    // Extra RFC 822 headers, e.g. the RFC 8058 List-Unsubscribe pair.
    headers?: Record<string, string>;
  },
): Promise<MailgunSendResult> {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey) throw new Error("Mailgun API key is missing");

  const domain = credentials.domain.trim().replace(/^@/, "");
  if (!domain) throw new Error("Mailgun sending domain is missing");

  const apiBase = normalizeMailgunApiBase(credentials.apiBase);
  const endpoint = `${apiBase}/v3/${encodeURIComponent(domain)}/messages`;
  const from = params.fromName
    ? `${params.fromName} <${params.from}>`
    : params.from;

  const body = new URLSearchParams();
  body.set("from", from);
  for (const email of params.to) body.append("to", email);
  body.set("subject", params.subject);
  if (params.text) body.set("text", params.text);
  if (params.html) body.set("html", params.html);
  if (params.replyTo) body.set("h:Reply-To", params.replyTo);
  for (const [name, value] of Object.entries(params.headers || {})) {
    body.set(`h:${name}`, value);
  }

  const authorization = `Basic ${Buffer.from(`api:${apiKey}`, "utf8").toString("base64")}`;
  let lastStatus = 0;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const text = await res.text();
    let json: MailgunResponse | null = null;
    try {
      json = text ? (JSON.parse(text) as MailgunResponse) : null;
    } catch {
      json = null;
    }

    const messageId = json?.id;
    if (res.ok && messageId) {
      const perRecipient: Record<string, string> = {};
      const perRecipientRef: Record<string, string> = {};
      const ref = stripMessageId(messageId);
      for (const email of params.to) {
        perRecipient[email] = messageId;
        if (ref) perRecipientRef[email] = ref;
      }
      return { messageId, perRecipient, perRecipientRef };
    }

    lastStatus = res.status;
    lastError =
      json?.message || json?.error || text || res.statusText || "unknown error";

    if (attempt < MAX_ATTEMPTS && RETRY_STATUSES.has(res.status)) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5_000)
          : 700 * attempt;
      await sleep(delayMs);
      continue;
    }
    break;
  }

  throw new Error(`Mailgun send failed (${lastStatus}): ${lastError}`);
}
