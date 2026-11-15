import "server-only";

import { BirdClient } from "@messagebird/sdk";

// Bird (MessageBird) transport. Each access key stores its own API key
// (bk_{region}_...), sent via the official @messagebird/sdk client. The region
// is inferred from the key prefix, so no base URL is required. The sending
// domain must be verified in the Bird workspace that owns the key.
//
// Bird accepts one message per send call with multiple recipients in `to`, and
// returns an `em_` message id plus an "accepted" status on success.

export type BirdSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  perRecipientRef: Record<string, string>;
};

export async function sendViaBird(
  apiKey: string,
  params: {
    to: string[];
    from: string;
    fromName?: string | null;
    replyTo?: string | null;
    subject: string;
    html?: string | null;
    text?: string | null;
    headers?: Record<string, string>;
  },
): Promise<BirdSendResult> {
  const key = (apiKey || "").trim();
  if (!key) throw new Error("Bird API key is missing");

  const from = params.fromName
    ? { email: params.from, name: params.fromName }
    : params.from;

  const bird = new BirdClient({ apiKey: key });

  const msg = await bird.email.send({
    from,
    to: params.to,
    subject: params.subject,
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.replyTo ? { reply_to: [params.replyTo] } : {}),
    ...(params.headers && Object.keys(params.headers).length
      ? { headers: params.headers }
      : {}),
  });

  const messageId = msg?.id;
  if (!messageId) {
    throw new Error("Bird send failed: no message id returned");
  }

  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const email of params.to) {
    perRecipient[email] = messageId;
    perRecipientRef[email] = messageId;
  }
  return { messageId, perRecipient, perRecipientRef };
}
