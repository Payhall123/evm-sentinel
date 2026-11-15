import "server-only";

// Elastic Email transport. Each access key stores its own API key, which is
// sent in the X-ElasticEmail-ApiKey header on every request. Credentials are
// per customer so one EVM Sentinel deployment can front many Elastic Email
// accounts without sharing a key.
//
// We use the bulk endpoint (not /emails/transactional) because campaign mail is
// bulk mail: Elastic Email only emits the RFC 8058 List-Unsubscribe header for
// bulk sends, and major mailbox providers (Outlook/Hotmail, Gmail, Yahoo) weigh
// that header heavily when deciding whether to filter a message. The bulk
// endpoint returns the same EmailSend shape with the MessageID we store as the
// correlation id:
// https://elasticemail.com/developers/api-documentation/rest-api#tag/Emails/operation/emailsPost

const ELASTICEMAIL_API_URL = (
  process.env.ELASTICEMAIL_API_URL || "https://api.elasticemail.com/v4"
).replace(/\/$/, "");

export type ElasticEmailSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Elastic Email assigns one MessageID per send; attribute it to every
  // recipient so callers have a stable identifier to store.
  perRecipientRef: Record<string, string>;
};

type BodyPart = {
  ContentType: "HTML" | "PlainText";
  Content: string;
  Charset: string;
};

type ElasticEmailResponse = {
  MessageID?: string;
  TransactionID?: string;
  Error?: string;
  Message?: string;
};

export async function sendViaElasticEmail(
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
): Promise<ElasticEmailSendResult> {
  const from = params.fromName
    ? `${params.fromName} <${params.from}>`
    : params.from;

  const body: BodyPart[] = [];
  if (params.html) body.push({ ContentType: "HTML", Content: params.html, Charset: "utf-8" });
  if (params.text) body.push({ ContentType: "PlainText", Content: params.text, Charset: "utf-8" });

  // The bulk endpoint takes recipient objects rather than the To/CC/BCC map the
  // transactional endpoint uses. One recipient per call keeps the dispatcher's
  // per-message retry and status bookkeeping intact.
  const payload = {
    Recipients: params.to.map((email) => ({ Email: email })),
    Content: {
      From: from,
      Subject: params.subject,
      ...(params.replyTo ? { ReplyTo: params.replyTo } : {}),
      ...(body.length ? { Body: body } : {}),
      ...(params.headers && Object.keys(params.headers).length
        ? { Headers: params.headers }
        : {}),
    },
  };

  const res = await fetch(`${ELASTICEMAIL_API_URL}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ElasticEmail-ApiKey": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: ElasticEmailResponse | null = null;
  try {
    json = text ? (JSON.parse(text) as ElasticEmailResponse) : null;
  } catch {
    json = null;
  }

  const messageId = json?.MessageID;
  if (!res.ok || !messageId) {
    const detail =
      json?.Error || json?.Message || text || res.statusText || "unknown error";
    throw new Error(`Elastic Email send failed (${res.status}): ${detail}`);
  }

  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const email of params.to) {
    perRecipient[email] = messageId;
    perRecipientRef[email] = messageId;
  }
  return { messageId, perRecipient, perRecipientRef };
}
