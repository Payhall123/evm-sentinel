import "server-only";

import nodemailer, { type Transporter } from "nodemailer";
import { stripMessageId } from "@/lib/delivery";

// SMTP submission through a Postal mailbox credential. Keys created in the
// "smtp" send mode have no Postal HTTP API credential, so the dispatcher sends
// through the mailbox the key was provisioned with instead of the send API.
export type SmtpAccount = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type SmtpSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Same id as `perRecipient`, but normalised for matching provider callbacks
  // (Postal echoes the Message-ID without its angle brackets).
  perRecipientRef: Record<string, string>;
};

// One pooled transport per mailbox so a campaign reuses a small number of
// authenticated connections instead of reconnecting (and re-authenticating)
// for every recipient.
const transports = new Map<string, Transporter>();

function transportFor(account: SmtpAccount): Transporter {
  const cacheKey = `${account.host}:${account.port}:${account.username}`;
  let transport = transports.get(cacheKey);
  if (!transport) {
    transport = nodemailer.createTransport({
      host: account.host,
      port: account.port,
      // 465 is implicit TLS; 587/25 negotiate STARTTLS. Postal serves 587 with
      // STARTTLS and ignores the SMTP username, but rejects a missing one.
      secure: account.port === 465,
      requireTLS: account.port !== 465,
      auth: { user: account.username, pass: account.password },
      pool: true,
      maxConnections: 3,
      maxMessages: 200,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    transports.set(cacheKey, transport);
  }
  return transport;
}

export async function sendViaSmtp(
  account: SmtpAccount,
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
): Promise<SmtpSendResult> {
  const transport = transportFor(account);
  const from = params.fromName ? { name: params.fromName, address: params.from } : params.from;
  const info = await transport.sendMail({
    from,
    to: params.to,
    replyTo: params.replyTo || undefined,
    subject: params.subject,
    html: params.html || undefined,
    text: params.text || undefined,
    headers: params.headers,
  });

  // SMTP submission yields a single queue id for the whole message; Postal
  // assigns its own per-recipient tokens downstream. Attribute the queue id to
  // every recipient so callers still get a stable identifier to store.
  const messageId = info.messageId || "";
  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  const ref = stripMessageId(messageId);
  for (const email of params.to) {
    perRecipient[email] = messageId;
    if (ref) perRecipientRef[email] = ref;
  }
  return { messageId, perRecipient, perRecipientRef };
}
