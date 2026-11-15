import "server-only";

import { createHash, createHmac } from "node:crypto";

// Amazon SES transport. Credentials are stored per access key so each customer
// can send through their own AWS account/region.
//
// API sends use the SES v2 SendEmail REST endpoint, signed with AWS Signature
// Version 4 (no AWS SDK dependency). SMTP sends reuse lib/smtp.ts against the
// regional SES SMTP endpoint.

export type SesApiCredentials = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSetName?: string | null;
};

export type SesSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // SES assigns one message id per send; attribute it to every recipient so
  // callers get a stable identifier to store for delivery reporting.
  perRecipientRef: Record<string, string>;
};

export function sesSmtpHost(region: string): string {
  return `email-smtp.${region}.amazonaws.com`;
}

export const SES_SMTP_DEFAULT_PORT = 587;

// AWS' documented conversion of an IAM secret access key into an SES SMTP
// password. The result is region-specific; the SMTP username is the access key
// id. https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
export function deriveSesSmtpPassword(secretAccessKey: string, region: string): string {
  const date = "11111111";
  let key = Buffer.from(`AWS4${secretAccessKey}`, "utf8");
  for (const message of [date, region, "ses", "aws4_request", "SendRawEmail"]) {
    key = createHmac("sha256", key).update(message, "utf8").digest();
  }
  // Version byte 0x04 prefixes the signature.
  return Buffer.concat([Buffer.from([0x04]), key]).toString("base64");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// Format used by AWS: 20261023T120000Z.
function amzDate(now: Date): { full: string; date: string } {
  const full = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return { full, date: full.slice(0, 8) };
}

export async function sendViaSesApi(
  credentials: SesApiCredentials,
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
): Promise<SesSendResult> {
  const { region, accessKeyId, secretAccessKey } = credentials;
  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";

  const from = params.fromName
    ? `${params.fromName} <${params.from}>`
    : params.from;

  const body = {
    FromEmailAddress: from,
    Destination: { ToAddresses: params.to },
    ReplyToAddresses: params.replyTo ? [params.replyTo] : undefined,
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          ...(params.html ? { Html: { Data: params.html, Charset: "UTF-8" } } : {}),
          ...(params.text ? { Text: { Data: params.text, Charset: "UTF-8" } } : {}),
        },
      },
    },
    ...(credentials.configurationSetName
      ? { ConfigurationSetName: credentials.configurationSetName }
      : {}),
    ...(params.headers && Object.keys(params.headers).length
      ? { Headers: Object.entries(params.headers).map(([Name, Value]) => ({ Name, Value })) }
      : {}),
  };
  const payload = JSON.stringify(body);
  const payloadHash = sha256Hex(payload);
  const { full: stamp, date } = amzDate(new Date());

  // Canonical request for a POST with no query string. The host header is set
  // by fetch but must be signed, so keep the same value here.
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-amz-date:${stamp}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonicalRequest = [
    "POST",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${region}/ses/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "ses");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const res = await fetch(`https://${host}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": stamp,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload,
  });

  type SesResponse = {
    MessageId?: string;
    message?: string;
    Message?: string;
    __type?: string;
  };
  const text = await res.text();
  let json: SesResponse | null = null;
  try {
    json = text ? (JSON.parse(text) as SesResponse) : null;
  } catch {
    json = null;
  }

  const messageId = json?.MessageId;
  if (!res.ok || !messageId) {
    const detail = json?.message || json?.Message || text || res.statusText || "unknown error";
    throw new Error(`Amazon SES send failed (${res.status}): ${detail}`);
  }

  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const email of params.to) {
    perRecipient[email] = messageId;
    perRecipientRef[email] = messageId;
  }
  return { messageId, perRecipient, perRecipientRef };
}
