import { NextResponse } from "next/server";

import { unsubscribeContact } from "@/lib/unsubscribe";

// Public by necessity: mail clients and mail servers POST here with no session,
// no API key and no CSRF token. Authorisation is the HMAC in the path -- see
// lib/unsubscribe.ts. proxy.ts only guards /admin and /dashboard, so /api/*
// already passes through unauthenticated.

type Ctx = { params: Promise<{ contactId: string; signature: string }> };

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#111">
<h1 style="font-size:1.25rem;margin:0 0 .75rem">${title}</h1>
<p style="margin:0">${body}</p>
</body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// RFC 8058 one-click. Google/Yahoo POST here with the body
// "List-Unsubscribe=One-Click" and only inspect the status code, so this
// returns a bare 200 and nothing else.
export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { contactId, signature } = await params;

    // Validate inputs
    if (!contactId || !signature) {
      console.warn("[api/unsubscribe] Missing contactId or signature");
      return new NextResponse(null, {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }

    await unsubscribeContact(contactId, signature);

    // Every outcome gets a 200. A 4xx teaches the client the header is broken,
    // and a tampered link reveals nothing useful about why it failed.
    return new NextResponse(null, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/unsubscribe] Error processing unsubscribe:", error);
    // Still return 200 to not leak information about why it failed
    return new NextResponse(null, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

// Human-facing path for clients that only render a link.
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { contactId, signature } = await params;

    // Validate inputs
    if (!contactId || !signature) {
      console.warn("[api/unsubscribe GET] Missing contactId or signature");
      return page("Invalid request", "Missing required parameters", 400);
    }

    const result = await unsubscribeContact(contactId, signature);

    if (!result.ok) {
      if (result.reason === "not_found") {
        return page("Link not valid", "This unsubscribe link does not match any recipient.", 404);
      }
      if (result.reason === "not_configured") {
        return page(
          "Unsubscribe unavailable",
          "This server has not finished configuring unsubscribe handling. Please contact the sender.",
          503
        );
      }
      // Handle other potential reasons
      return page("Link not valid", "This unsubscribe link is no longer valid.", 400);
    }

    return page(
      "Unsubscribed",
      result.already
        ? `${result.email} was already unsubscribed. No further email will be sent.`
        : `${result.email} has been unsubscribed. No further email will be sent.`
    );
  } catch (error) {
    console.error("[api/unsubscribe GET] Unexpected error:", error);
    return page(
      "Error processing request",
      "An unexpected error occurred. Please try again later.",
      500
    );
  }
}