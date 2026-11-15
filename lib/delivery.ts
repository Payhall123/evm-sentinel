import "server-only";

// Canonical delivery buckets shared by the webhook ingest and the analytics UI.
// These describe what the *transport* did with a message after we handed it
// over, which is independent of the app's own `Message.status` (accepted by us
// vs. failed before sending).
export type DeliveryBucket = "sent" | "soft_fail" | "hard_fail" | "bounced" | "held";

// Postal webhook event -> the delivery status it represents (see
// WebhookEvent::EVENTS + Postal::MessageDB::Delivery#webhook_event).
const POSTAL_EVENT_STATUS: Record<string, string> = {
  MessageSent: "Sent",
  MessageDelayed: "SoftFail",
  MessageDeliveryFailed: "HardFail",
  MessageHeld: "Held",
  MessageBounced: "Bounced",
};

export function postalEventToStatus(event: string): string | null {
  return POSTAL_EVENT_STATUS[event] ?? null;
}

// Raw provider status -> normalised bucket.
export function normalizeDeliveryStatus(raw: string | null | undefined): DeliveryBucket | null {
  switch ((raw || "").toLowerCase()) {
    case "sent":
    case "delivered":
      return "sent";
    case "softfail":
    case "soft_fail":
    case "delayed":
      return "soft_fail";
    case "hardfail":
    case "hard_fail":
    case "failed":
      return "hard_fail";
    case "bounced":
    case "bounce":
      return "bounced";
    case "held":
    case "hold":
      return "held";
    default:
      return null;
  }
}

// Postal stores the Message-ID header with the surrounding angle brackets
// stripped. Apply the same treatment to the id our SMTP transport records so
// the value we persist as `correlationId` lines up with the webhook payload.
export function stripMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^</, "").replace(/>$/, "");
  return trimmed || null;
}

// The transport that produced a message, derived from the key it was sent with.
export function providerFor(accessKey: {
  provider: string;
  sendMode: string;
  postalApiKey?: string | null;
  smtpPassword?: string | null;
  sesAccessKeyId?: string | null;
  sesSmtpPassword?: string | null;
}): "postal-api" | "postal-smtp" | "devner" | "ses-api" | "ses-smtp" | "elasticemail" | "resend" | "mailgun" | "smtp" | "zeptomail" | "cloudflare" | "bird" {
  if (accessKey.provider === "devner") return "devner";
  if (accessKey.provider === "elasticemail") return "elasticemail";
  if (accessKey.provider === "cloudflare") return "cloudflare";
  if (accessKey.provider === "resend") return "resend";
  if (accessKey.provider === "bird") return "bird";
  if (accessKey.provider === "mailgun") return "mailgun";
  if (accessKey.provider === "zeptomail") return "zeptomail";
  if (accessKey.provider === "smtp" || accessKey.provider === "custom") return "smtp";
  if (accessKey.provider === "ses") {
    const usesSmtp =
      accessKey.sendMode === "smtp" ||
      (!accessKey.sesAccessKeyId && Boolean(accessKey.sesSmtpPassword));
    return usesSmtp ? "ses-smtp" : "ses-api";
  }
  const usesSmtp =
    accessKey.sendMode === "smtp" || (!accessKey.postalApiKey && Boolean(accessKey.smtpPassword));
  return usesSmtp ? "postal-smtp" : "postal-api";
}
