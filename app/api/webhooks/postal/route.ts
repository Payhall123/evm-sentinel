import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { normalizeDeliveryStatus, postalEventToStatus, stripMessageId } from "@/lib/delivery";

// Public endpoint Postal posts delivery events to. Registered per mail server by
// lib/webhooks.ts with a per-key secret in the query string (?k=...), which is
// how we attribute a callback to the right access key. No session/auth here:
// the only callers are Postal and the secret is the credential.
export const dynamic = "force-dynamic";

type PostalMessage = {
  id?: number;
  token?: string;
  message_id?: string;
  to?: string;
  from?: string;
  subject?: string;
};

type PostalEnvelope = {
  event?: string;
  timestamp?: number;
  uuid?: string;
  payload?: {
    message?: PostalMessage;
    // MessageBounced nests the original message under this key instead.
    original_message?: PostalMessage;
    status?: string;
    details?: string;
    output?: string;
    // `timestamp` is the delivery time; `time` is an optional secondary stamp.
    timestamp?: number;
    time?: number;
  };
};

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("k");
  if (!secret) {
    return NextResponse.json({ error: "missing key" }, { status: 401 });
  }

  const accessKey = await prisma.accessKey.findFirst({
    where: { postalWebhookSecret: secret },
    select: { id: true },
  });
  if (!accessKey) {
    console.warn("[api/webhooks/postal] unknown webhook secret");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PostalEnvelope;
  try {
    body = (await req.json()) as PostalEnvelope;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const event = String(body.event || "");
  const status = postalEventToStatus(event);
  if (!status) {
    // Events we don't surface (clicks, loads, DNS errors, send limits). Acknowledge
    // so Postal stops retrying rather than leaving it queued forever.
    return NextResponse.json({ ok: true, ignored: event || "unknown" });
  }

  const payload = body.payload || {};
  const msg = payload.original_message || payload.message;
  const messageId = stripMessageId(msg?.message_id);
  const token = msg?.token || null;

  if (!messageId && !token) {
    return NextResponse.json({ ok: true, ignored: "no message reference" });
  }

  // Match on whichever identifier we stored when we sent the message: the token
  // for API sends, the stripped Message-ID for SMTP sends. `postalId` is kept as
  // a fallback for messages sent before correlationId existed. The match is
  // scoped to this key's own campaigns so that two keys sharing one mail server
  // (each with its own webhook) can never touch each other's messages.
  const message = await prisma.message.findFirst({
    where: {
      campaign: { accessKeyId: accessKey.id },
      OR: [
        ...(token ? [{ correlationId: token }] : []),
        ...(messageId
          ? [{ correlationId: messageId }, { postalId: messageId }, { postalId: `<${messageId}>` }]
          : []),
      ],
    },
    select: { id: true, deliveryUpdatedAt: true },
    orderBy: { createdAt: "desc" },
  });

  if (!message) {
    console.warn(`[api/webhooks/postal] no message matched (event=${event} mid=${messageId} token=${token})`);
    return NextResponse.json({ ok: true, matched: false });
  }

  const bucket = normalizeDeliveryStatus(status);
  const detail =
    payload.details ?? (event === "MessageBounced" ? "Bounce message received" : null);
  // Prefer the delivery's own timestamp, then its secondary stamp, then the
  // envelope's creation time. Ordering by this value keeps the latest outcome
  // correct even when Postal retries an event out of order.
  const providerAt =
    typeof payload.timestamp === "number"
      ? new Date(payload.timestamp * 1000)
      : typeof payload.time === "number"
        ? new Date(payload.time * 1000)
        : typeof body.timestamp === "number"
          ? new Date(body.timestamp * 1000)
          : null;

  // Postal can deliver the same event more than once (retries). Keep the
  // timeline free of duplicates for an identical (event, time) pair.
  const duplicate = providerAt
    ? await prisma.deliveryEvent.findFirst({
        where: { messageId: message.id, event, providerAt },
        select: { id: true },
      })
    : null;

  if (!duplicate) {
    await prisma.deliveryEvent.create({
      data: {
        messageId: message.id,
        event,
        status,
        deliveryStatus: bucket || status,
        detail,
        output: payload.output ?? null,
        providerAt,
      },
    });
  }

  // Advance the "latest outcome" only for events newer than what we already have,
  // so a late/duplicate retry can't roll a Bounced message back to Sent.
  const isNewer = !message.deliveryUpdatedAt || !providerAt || providerAt >= message.deliveryUpdatedAt;
  if (isNewer) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus: bucket || status,
        deliveryDetail: detail,
        deliveryOutput: payload.output ?? null,
        deliveryUpdatedAt: providerAt ?? new Date(),
      },
    });
  }

  return NextResponse.json({ ok: true, matched: true, status });
}
