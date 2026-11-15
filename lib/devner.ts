import "server-only";

// Devner is the Gmail-backed transactional relay used as an alternative mail
// transport to Postal. Credentials are the customer's Devner API keys (sl_...).
const DEVNER_URL = (process.env.DEVNER_API_URL || "http://localhost:3000").replace(/\/$/, "");

export type DevnerSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Devner reports its own message id per send; kept for future delivery
  // callbacks (Devner has no delivery webhook today).
  perRecipientRef: Record<string, string>;
};

// Sends one message through POST {DEVNER_API_URL}/api/send. `from` is optional:
// when it is omitted Devner rotates across the Gmail/Microsoft mailboxes
// connected to the account that owns the API key, which is what callers want
// when they do not manage sender addresses themselves. When it is supplied it
// must belong to a connected mailbox or Devner rejects the request with a 400.
export async function sendViaDevner(
  apiKey: string,
  params: {
    to: string[];
    from?: string | null;
    fromName?: string | null;
    replyTo?: string | null;
    subject: string;
    html?: string | null;
    text?: string | null;
    // Per-recipient opt-out endpoint. Devner turns this into the RFC 8058
    // List-Unsubscribe / List-Unsubscribe-Post pair. It requires exactly one
    // "to" address, since the link identifies a single mailbox.
    unsubscribeUrl?: string;
  },
): Promise<DevnerSendResult> {
  const from =
    params.from && params.fromName ? `${params.fromName} <${params.from}>` : params.from || undefined;

  const res = await fetch(`${DEVNER_URL}/api/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      to: params.to,
      from,
      subject: params.subject,
      html: params.html || undefined,
      text: params.text || undefined,
      replyTo: params.replyTo || undefined,
      unsubscribeUrl: params.unsubscribeUrl || undefined,
    }),
  });

  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; messageId?: string; message?: string }
    | null;

  if (!res.ok || !json || json.success !== true || !json.messageId) {
    throw new Error(`Devner send failed (${res.status}): ${json?.message || res.statusText || "unknown error"}`);
  }

  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const email of params.to) {
    perRecipient[email] = json.messageId;
    perRecipientRef[email] = json.messageId;
  }
  return { messageId: json.messageId, perRecipient, perRecipientRef };
}
