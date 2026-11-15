import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const secret = process.env.SESSION_SECRET || "dev-session-secret-change-me";
const encoded = new TextEncoder().encode(secret);

const PUBLIC_PATHS = ["/login", "/_next", "/favicon.ico", "/postal-check"];

async function readSession(req: NextRequest) {
  const token = req.cookies.get("evms_session")?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, encoded, { algorithms: ["HS256"] });
    return payload as { role: string };
  } catch {
    return null;
  }
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const session = await readSession(req);
  if (pathname.startsWith("/admin")) {
    if (session?.role !== "admin") {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  } else if (pathname.startsWith("/dashboard")) {
    if (session?.role !== "user") {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  // `api/contacts/import` is excluded on purpose: when the proxy matches a
  // request Next.js buffers (clones) the whole body in memory, capped at the
  // `proxyClientMaxBodySize` default of 10MB. A large contact upload would be
  // silently truncated there, so the batched-import route reads its own body and
  // performs its own auth instead.
  matcher: ["/((?!_next/static|_next/image|api/contacts/import|.*\\.png$|.*\\.ico$).*)"],
};