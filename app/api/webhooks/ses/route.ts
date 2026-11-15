import { NextRequest, NextResponse, after } from "next/server";
import { createVerify, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { stripMessageId, type DeliveryBucket } from "@/lib/delivery";

// Public endpoint for Amazon SES event publishing (SNS -> HTTPS).
//
// SNS is configured with this URL plus a per-deployment secret in the query
// string (?k=...), the same first-gate model as the Postal webhook. The secret
// is only a cheap way to shed junk traffic: every request is also checked
// against the SNS signature so a caller that knows the URL cannot forge an
// event. Signature verification follows:
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
//
// SNS sends a SubscriptionConfirmation on first setup, which this route
// confirms. Notifications are acknowledged before the database work runs so
// SNS never waits on (or retries because of) our processing time.
//
// Expected SES event types: Delivery, Bounce, Complaint, DeliveryDelay, Reject.
// Open/Click events are acknowledged and ignored.
export const dynamic = "force-dynamic";

// The topic this deployment trusts. Overridable for a different AWS account,
// but defaulting it means a signature from any other topic is not enough.
const DEFAULT_TOPIC_ARN = "arn:aws:sns:us-east-1:450653396640:evms-ses-events";

type SesRecipient = {
  emailAddress?: string;
  diagnosticCode?: string;
};

type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: {
    messageId?: string;
    timestamp?: string;
    source?: string;
    destination?: string[];
    commonHeaders?: {
      messageId?: string;
      from?: string[];
      to?: string[];
      subject?: string;
    };
  };
  delivery?: {
    timestamp?: string;
    recipients?: string[];
    processingTimeMillis?: number;
    reportingMTA?: string;
  };
  deliveryDelay?: {
    timestamp?: string;
    delayType?: string;
    delayedRecipients?: SesRecipient[];
  };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesRecipient[];
    timestamp?: string;
    reportingMTA?: string;
  };
  complaint?: {
    complainedRecipients?: SesRecipient[];
    complaintFeedbackType?: string;
    timestamp?: string;
  };
  reject?: {
    reason?: string;
  };
};

type SnsEnvelope = {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  SubscribeURL?: string;
  Token?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
};

function secretMatches(provided: string | null): boolean {
  const expected = process.env.SES_WEBHOOK_SECRET || "";
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only SNS control-plane hosts are acceptable for either the signing
// certificate or the subscription-confirmation URL. This keeps the route from
// becoming an SSRF gadget if an attacker can reach it with a valid secret.
function isAwsSnsHost(hostname: string): boolean {
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(hostname);
}

function isSnsCertUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      isAwsSnsHost(url.hostname) &&
      url.pathname.toLowerCase().endsWith(".pem")
    );
  } catch {
    return false;
  }
}

function isSnsSubscribeUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isAwsSnsHost(url.hostname);
  } catch {
    return false;
  }
}

type CachedCert = { pem: string; fetchedAt: number };
const certCache = new Map<string, CachedCert>();
const CERT_TTL_MS = 6 * 60 * 60 * 1000;
const CERT_MAX_BYTES = 64 * 1024;

async function signingCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CERT_TTL_MS) return cached.pem;

  const res = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`signing certificate returned ${res.status}`);
  const pem = await res.text();
  if (pem.length > CERT_MAX_BYTES || !pem.includes("BEGIN CERTIFICATE")) {
    throw new Error("signing certificate was not a PEM certificate");
  }
  certCache.set(url, { pem, fetchedAt: Date.now() });
  return pem;
}

// The exact canonical string SNS signs. Notification includes Subject only when
// it was actually present; confirmation types sign SubscribeURL/Token instead.
function canonicalString(envelope: SnsEnvelope): string {
  if (envelope.Type === "Notification") {
    return (
      [
        envelope.Message ?? "",
        envelope.MessageId ?? "",
        ...(envelope.Subject !== undefined ? [envelope.Subject] : []),
        envelope.Timestamp ?? "",
        envelope.TopicArn ?? "",
        envelope.Type ?? "",
      ].join("\n") + "\n"
    );
  }
  return (
    [
      envelope.Message ?? "",
      envelope.MessageId ?? "",
      envelope.SubscribeURL ?? "",
      envelope.Timestamp ?? "",
      envelope.Token ?? "",
      envelope.TopicArn ?? "",
      envelope.Type ?? "",
    ].join("\n") + "\n"
  );
}

async function verifySnsSignature(envelope: SnsEnvelope): Promise<boolean> {
  if (!envelope.Signature || !isSnsCertUrl(envelope.SigningCertURL)) return false;
  if (!envelope.Type || !envelope.MessageId || !envelope.Timestamp || !envelope.TopicArn) {
    return false;
  }

  const expectedTopic = process.env.SES_SNS_TOPIC_ARN || DEFAULT_TOPIC_ARN;
  if (expectedTopic && envelope.TopicArn !== expectedTopic) {
    console.warn(`[api/webhooks/ses] unexpected topic ${envelope.TopicArn}`);
    return false;
  }

  const algorithm =
    envelope.SignatureVersion === "1"
      ? "RSA-SHA1"
      : envelope.SignatureVersion === "2"
        ? "RSA-SHA256"
        : null;
  if (!algorithm) {
    console.warn(`[api/webhooks/ses] unsupported signature version ${envelope.SignatureVersion}`);
    return false;
  }

  let pem: string;
  try {
    pem = await signingCert(envelope.SigningCertURL);
  } catch (e) {
    console.error("[api/webhooks/ses] could not fetch signing certificate", e);
    return false;
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString(envelope), "utf8");
    return verifier.verify(pem, envelope.Signature, "base64");
  } catch (e) {
    console.error("[api/webhooks/ses] signature verification failed", e);
    return false;
  }
}

function bucketFor(eventType: string, bounceType: string | undefined): DeliveryBucket | null {
  switch (eventType.toLowerCase()) {
    case "delivery":
      return "sent";
    case "deliverydelay":
      return "soft_fail";
    case "reject":
      return "hard_fail";
    case "bounce":
      return bounceType?.toLowerCase() === "permanent" ? "bounced" : "soft_fail";
    case "complaint":
      // A complaint is not a bounce, but it belongs in the same "issue"
      // bucket in the UI; the detail string preserves the distinction.
      return "bounced";
    default:
      return null;
  }
}

function statusFor(eventType: string, bounceType: string | undefined): string {
  switch (eventType.toLowerCase()) {
    case "delivery":
      return "Delivered";
    case "deliverydelay":
      return "DeliveryDelay";
    case "reject":
      return "Rejected";
    case "bounce":
      return bounceType?.toLowerCase() === "permanent" ? "Bounced" : "SoftFail";
    case "complaint":
      return "Complaint";
    default:
      return eventType;
  }
}

function detailFor(event: SesEvent): string | null {
  const type = String(event.eventType || event.notificationType || "").toLowerCase();
  if (type === "bounce") {
    const rcpt = event.bounce?.bouncedRecipients?.[0];
    return [
      `${event.bounce?.bounceType ?? "Unknown"} bounce`,
      event.bounce?.bounceSubType ? `(${event.bounce.bounceSubType})` : "",
      rcpt?.diagnosticCode ? `- ${rcpt.diagnosticCode}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (type === "complaint") {
    const feedback = event.complaint?.complaintFeedbackType;
    return feedback ? `Complaint (${feedback})` : "Complaint";
  }
  if (type === "reject") return event.reject?.reason ?? "Rejected by Amazon SES";
  if (type === "deliverydelay") {
    const delay = event.deliveryDelay;
    return delay?.delayType ? `Delivery delay (${delay.delayType})` : "Delivery delay";
  }
  return null;
}

// `mail.destination` is the authoritative recipient list for the SES send, but
// the event-specific arrays name the exact mailbox that bounced or complained.
// Union them so suppression covers both the precise recipient and the send.
function recipientsFor(event: SesEvent): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined | null) => {
    if (value && value.includes("@")) out.add(value.trim().toLowerCase());
  };
  for (const r of event.bounce?.bouncedRecipients ?? []) add(r.emailAddress);
  for (const r of event.complaint?.complainedRecipients ?? []) add(r.emailAddress);
  for (const r of event.deliveryDelay?.delayedRecipients ?? []) add(r.emailAddress);
  for (const r of event.delivery?.recipients ?? []) add(r);
  for (const r of event.mail?.destination ?? []) add(r);
  return [...out];
}

function providerTimestamp(event: SesEvent): Date | null {
  const raw =
    event.bounce?.timestamp ||
    event.complaint?.timestamp ||
    event.delivery?.timestamp ||
    event.deliveryDelay?.timestamp ||
    event.mail?.timestamp;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function confirmSubscription(subscribeUrl: string): Promise<boolean> {
  try {
    const res = await fetch(subscribeUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(`[api/webhooks/ses] subscription confirm returned ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[api/webhooks/ses] subscription confirm failed", e);
    return false;
  }
}

async function processNotification(envelope: SnsEnvelope): Promise<void> {
  let event: SesEvent;
  try {
    event = JSON.parse(envelope.Message || "") as SesEvent;
  } catch {
    console.warn("[api/webhooks/ses] notification Message was not JSON");
    return;
  }

  const eventType = String(event.eventType || event.notificationType || "");
  if (!eventType) return;

  const bucket = bucketFor(eventType, event.bounce?.bounceType);
  if (!bucket) {
    // Open, Click, Send and other events we do not surface.
    console.info(`[api/webhooks/ses] ignored event ${eventType}`);
    return;
  }

  // SES API sends store the SES MessageId as correlationId. SES SMTP sends
  // store the RFC 5322 Message-ID, which SES echoes in commonHeaders.
  const sesMessageId = event.mail?.messageId;
  const headerMessageId = stripMessageId(event.mail?.commonHeaders?.messageId);
  if (!sesMessageId && !headerMessageId) {
    console.warn(`[api/webhooks/ses] ${eventType} had no message identifier`);
    return;
  }

  const message = await prisma.message.findFirst({
    where: {
      provider: { in: ["ses-api", "ses-smtp"] },
      OR: [
        ...(sesMessageId ? [{ correlationId: sesMessageId }] : []),
        ...(headerMessageId ? [{ correlationId: headerMessageId }] : []),
      ],
    },
    select: {
      id: true,
      deliveryUpdatedAt: true,
      campaign: { select: { accessKeyId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!message) {
    console.warn(
      `[api/webhooks/ses] no message matched (event=${eventType} ses=${sesMessageId} header=${headerMessageId})`,
    );
    return;
  }

  const providerAt = providerTimestamp(event);
  const status = statusFor(eventType, event.bounce?.bounceType);
  const detail = detailFor(event);

  // SNS can deliver the same event more than once (retries). Keep the timeline
  // free of duplicates for an identical (event, time) pair.
  const duplicate = providerAt
    ? await prisma.deliveryEvent.findFirst({
        where: { messageId: message.id, event: eventType, providerAt },
        select: { id: true },
      })
    : null;

  if (!duplicate) {
    await prisma.deliveryEvent.create({
      data: {
        messageId: message.id,
        event: eventType,
        status,
        deliveryStatus: bucket,
        detail,
        output: null,
        providerAt,
      },
    });
  }

  // Advance the "latest outcome" only for events newer than what we already
  // have, so a late/duplicate retry can't roll a Bounced message back to Sent.
  const isNewer = !message.deliveryUpdatedAt || !providerAt || providerAt >= message.deliveryUpdatedAt;
  if (isNewer) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: bucket,
        deliveryDetail: detail,
        deliveryUpdatedAt: providerAt ?? new Date(),
      },
    });
  }

  // Permanent bounces and complaints must never be sent to again. The
  // dispatcher checks Suppression before every message, so an entry here is
  // durable across list re-imports. Transient bounces and delivery delays are
  // deliberately not suppressed: they may succeed on a later attempt.
  const type = eventType.toLowerCase();
  const suppressionReason =
    type === "complaint"
      ? "complained"
      : type === "bounce" && event.bounce?.bounceType?.toLowerCase() === "permanent"
        ? "bounced"
        : null;

  if (suppressionReason) {
    for (const email of recipientsFor(event)) {
      await prisma.suppression.upsert({
        where: { accessKeyId_email: { accessKeyId: message.campaign.accessKeyId, email } },
        create: { accessKeyId: message.campaign.accessKeyId, email, reason: suppressionReason },
        update: {},
      });
    }
  }

  console.info(
    `[api/webhooks/ses] ${eventType} -> ${bucket} (message=${message.id} suppressed=${Boolean(suppressionReason)})`,
  );
}

export async function POST(req: NextRequest) {
  if (!secretMatches(req.nextUrl.searchParams.get("k"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  const raw = await req.text();
  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!(await verifySnsSignature(envelope))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 403 });
  }

  if (
    envelope.Type === "SubscriptionConfirmation" ||
    envelope.Type === "UnsubscribeConfirmation"
  ) {
    if (!isSnsSubscribeUrl(envelope.SubscribeURL)) {
      return NextResponse.json({ error: "invalid subscribe url" }, { status: 400 });
    }
    const confirmed = await confirmSubscription(envelope.SubscribeURL);
    return NextResponse.json({ ok: confirmed, confirmed }, { status: confirmed ? 200 : 502 });
  }

  if (envelope.Type !== "Notification" || !envelope.Message) {
    return NextResponse.json({ ok: true, ignored: envelope.Type || "unknown" });
  }

  // Acknowledge immediately. SNS retries with backoff on failures/timeouts, so
  // the database work must not sit between the request and the 2xx response.
  after(async () => {
    try {
      await processNotification(envelope);
    } catch (e) {
      console.error("[api/webhooks/ses] notification processing failed", e);
    }
  });

  return NextResponse.json({ ok: true, accepted: true });
}
