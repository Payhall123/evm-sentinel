// EVM Sentinel test mailer.
//
// Sends a test message through the same Resend transport the dispatcher uses
// (lib/resend.ts), so it exercises the production code path.
//
// Usage (from the project root):
//   npm run mail:test -- recipient@example.com
//   RESEND_API_KEY=re_... npm run mail:test -- recipient@example.com
//   npm run mail:test -- recipient@example.com re_...   # key as 2nd arg
//
// Optional overrides:
//   TEST_MAIL_FROM   sender address (default mail@diveru.ink)
//   TEST_MAIL_NAME   sender display name (default "EVM Sentinel")
//   RESEND_API_URL   API base (default https://api.resend.com)

import { sendViaResend } from "../lib/resend";

const FROM = (process.env.TEST_MAIL_FROM || "mail@diveru.ink").trim();
const FROM_NAME = (process.env.TEST_MAIL_NAME || "EVM Sentinel").trim();
const API_URL = (process.env.RESEND_API_URL || "https://api.resend.com").replace(/\/$/, "");

function usage(): never {
  console.error(
    [
      "Usage: npm run mail:test -- <recipient@example.com> [resend_api_key]",
      "",
      "The API key is taken from the optional second argument or the",
      "RESEND_API_KEY environment variable.",
    ].join("\n"),
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliveryStatus(apiKey: string, messageId: string): Promise<string | null> {
  const res = await fetch(`${API_URL}/emails/${messageId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { last_event?: string } | null;
  return body?.last_event ?? null;
}

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes("@")) usage();
  const apiKey = process.argv[3] || process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("No Resend API key: pass it as the second argument or set RESEND_API_KEY.");
    usage();
  }

  console.log(`Sending test mail: ${FROM_NAME} <${FROM}> -> ${to}`);

  const result = await sendViaResend(apiKey, {
    to: [to],
    from: FROM,
    fromName: FROM_NAME,
    replyTo: FROM,
    subject: "EVM Sentinel - test mail",
    text: [
      "This is a test message from EVM Sentinel.",
      "",
      "It was sent through the same Resend transport the campaign dispatcher uses.",
      "If you received this, delivery is working.",
    ].join("\n"),
    html:
      '<div style="font-family:Arial,sans-serif;max-width:560px;color:#18181b">' +
      '<h2 style="color:#0e7490">EVM Sentinel test</h2>' +
      "<p>This is a test message from <strong>EVM Sentinel</strong>.</p>" +
      "<p>It was sent through the same Resend transport the campaign dispatcher uses. " +
      "If you received this, delivery is working.</p>" +
      "</div>",
    headers: { "List-Unsubscribe": `<mailto:${FROM}?subject=unsubscribe>` },
  });

  console.log(`Accepted by Resend. id: ${result.messageId}`);

  // Resend reports delivery asynchronously; poll briefly and surface the event.
  const deadline = Date.now() + 30_000;
  let lastEvent: string | null = null;
  while (Date.now() < deadline) {
    await sleep(3_000);
    lastEvent = await deliveryStatus(apiKey, result.messageId);
    if (lastEvent && !["queued", "scheduled"].includes(lastEvent)) break;
  }
  console.log(`Delivery status: ${lastEvent ?? "pending (check the Resend dashboard)"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
