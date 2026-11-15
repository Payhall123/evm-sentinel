import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { stripMessageId, type DeliveryBucket } from "@/lib/delivery";

// Public endpoint for Mailgun domain webhooks.
//
// The URL carries a per-access-key secret (?k=...) that is generated when the
// key is created and registered with Mailgun by the dispatcher. That secret is
// the request gate; unlike the SES route there is no account-wide signing key
// to verify because Mailgun signing keys are per-account and not supplied by
// the API. Use a dedicated sending account where stronger verification is
// required.
//
// Mailgun's webhook body wraps the event in "event-data". We acknowledge with
// 200 immediately and process the database work with after(), so Mailgun never
// waits on (or retries because of) our processing time.
//
// Expected events: delivered, failed (severity permanent/temporary), complained.

type MailgunEvent = {
  event?: string;
  severity?: string;
  reason?: string;
  recipient?: string;
  timestamp?: number;
  message?: { headers?: Record<string, string> };
  "delivery-status"?: {
    code?: number;
    message?: string;
    description?: string;
  };
};

type MailgunWebhookBody = {
  "event-data"?: MailgunEvent;
  event?: string;
  signature?: unknown;
};

type Outcome = {
  bucket: DeliveryBucket;
  status: string;
  detail: string | null;
  suppressionReason: string | null;
};

function detailFor(event: MailgunEvent): string | null {
  const ds = event["delivery-status"];
  const rawMessage = ds?.message?.trim();
  const parts = [
    event.reason?.trim(),
    ds?.description?.trim(),
    rawMessage && rawMessage !== "OK" ? rawMessage : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : null;
}

function outcomeFor(event: MailgunEvent): Outcome | null {
  const type = String(event.event || "").toLowerCase();
  const detail = detailFor(event);
  if (type === "delivered") {
    return { bucket: "sent", status: "Delivered", detail, suppressionReason: null };
  }
  if (type === "failed") {
    const permanent =
      String(event.severity || "").toLowerCase() === "permanent" ||
      Number(event["delivery-status"]?.code) >= 500;
    if (permanent) {
      const reason = String(event.reason || "").toLowerCase();
      const suppressionReason = reason.includes("unsubscribe")
        ? "unsubscribed"
        : reason.includes("complaint")
          ? "complained"
          : "bounced";
      return {
        bucket: "hard_fail",
        status: "Failed",
        detail,
        suppressionReason,
      };
    }
    return { bucket: "soft_fail", status: "SoftFail", detail, suppressionReason: null };
  }
  if (type === "rejected") {
    return { bucket: "hard_fail", status: "Rejected", detail, suppressionReason: "bounced" };
  }
  if (type === "complained") {
    return {
      bucket: "bounced",
      status: "Complaint",
      detail: detail || "Recipient complained",
      suppressionReason: "complained",
    };
  }
  return null;
}

function providerTimestamp(event: MailgunEvent): Date | null {
  const seconds = Number(event.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const parsed = new Date(seconds * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function processEvent(accessKeyId: string, event: MailgunEvent): Promise<void> {
  const eventType = String(event.event || "").toLowerCase();
  const outcome = outcomeFor(event);
  if (!outcome) {
    console.info(`[api/webhooks/mailgun] ignored event ${eventType || "(none)"}`);
    return;
  }

  const headers = event.message?.headers || {};
  const headerMessageId = stripMessageId(
    headers["message-id"] || headers["Message-Id"] || headers["Message-ID"],
  );
  if (!headerMessageId) {
    console.warn(`[api/webhooks/mailgun] ${eventType} had no message-id`);
    return;
  }

  const message = await prisma.message.findFirst({
    where: {
      provider: "mailgun",
      correlationId: headerMessageId,
      campaign: { accessKeyId },
    },
    select: {
      id: true,
      email: true,
      deliveryUpdatedAt: true,
      campaign: { select: { accessKeyId: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!message) {
    console.warn(
      `[api/webhooks/mailgun] no message matched (event=${eventType} messageId=${headerMessageId})`,
    );
    return;
  }

  const providerAt = providerTimestamp(event);
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
        status: outcome.status,
        deliveryStatus: outcome.bucket,
        detail: outcome.detail,
        output: null,
        providerAt,
      },
    });
  }

  // Advance the latest outcome only for events newer than what we already have,
  // so a duplicate retry cannot roll a failed message back to delivered.
  const isNewer =
    !message.deliveryUpdatedAt ||
    !providerAt ||
    providerAt >= message.deliveryUpdatedAt;
  if (isNewer) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: outcome.bucket,
        deliveryDetail: outcome.detail,
        deliveryUpdatedAt: providerAt ?? new Date(),
      },
    });
  }

  if (outcome.suppressionReason) {
    const rawRecipient = event.recipient || message.email;
    const email = rawRecipient?.trim().toLowerCase();
    if (email?.includes("@")) {
      await prisma.suppression.upsert({
        where: { accessKeyId_email: { accessKeyId, email } },
        create: { accessKeyId, email, reason: outcome.suppressionReason },
        update: {},
      });
    }
  }

  console.info(
    `[api/webhooks/mailgun] ${eventType} -> ${outcome.bucket} (message=${message.id} suppressed=${Boolean(
      outcome.suppressionReason,
    )})`,
  );
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.nextUrl.searchParams.get("k") || "";
  if (!secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const accessKey = await prisma.accessKey.findUnique({
    where: { mailgunWebhookSecret: secret },
    select: { id: true },
  });
  if (!accessKey) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: MailgunWebhookBody;
  try {
    body = (await req.json()) as MailgunWebhookBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  const event = body["event-data"] ?? (body as unknown as MailgunEvent);
  if (!event || typeof event !== "object") {
    return NextResponse.json({ error: "invalid event" }, { status: 400 });
  }

  after(async () => {
    try {
      await processEvent(accessKey.id, event);
    } catch (e) {
      console.error("[api/webhooks/mailgun] event processing failed", e);
    }
  });

  return NextResponse.json({ ok: true, accepted: true });
}
