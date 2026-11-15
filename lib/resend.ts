import "server-only";

// Resend transport. Each access key stores its own API key, sent as a Bearer
// token on every request, so one EVM Sentinel deployment can front many Resend
// accounts without sharing a key. The sending domain must be verified in the
// account that owns the key.
//
// Resend has a single send endpoint for both transactional and marketing mail:
// POST https://api.resend.com/emails
// Returns { id } on success; errors come back as { statusCode, name, message }.
// Custom `headers` are passed through, so the RFC 8058 List-Unsubscribe pair
// reaches the recipient intact.

const RESEND_API_URL = (
  process.env.RESEND_API_URL || "https://api.resend.com"
).replace(/\/$/, "");

export type ResendSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Resend assigns one email id per send; attribute it to every recipient so
  // callers get a stable identifier to store for delivery reporting.
  perRecipientRef: Record<string, string>;
};

type ResendResponse = {
  id?: string;
  statusCode?: number;
  name?: string;
  message?: string;
  error?: string;
};

// Resend's default rate limit is 2 requests/second, and the dispatcher can push
// a batch faster than that. Retry the transient responses with a small backoff
// rather than failing the message permanently.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendViaResend(
  apiKey: string,
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
): Promise<ResendSendResult> {
  const from = params.fromName
    ? `${params.fromName} <${params.from}>`
    : params.from;

  const payload = {
    from,
    to: params.to,
    subject: params.subject,
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    ...(params.headers && Object.keys(params.headers).length
      ? { headers: params.headers }
      : {}),
  };

  let lastStatus = 0;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json: ResendResponse | null = null;
    try {
      json = text ? (JSON.parse(text) as ResendResponse) : null;
    } catch {
      json = null;
    }

    const messageId = json?.id;
    if (res.ok && messageId) {
      const perRecipient: Record<string, string> = {};
      const perRecipientRef: Record<string, string> = {};
      for (const email of params.to) {
        perRecipient[email] = messageId;
        perRecipientRef[email] = messageId;
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

  throw new Error(`Resend send failed (${lastStatus}): ${lastError}`);
}
