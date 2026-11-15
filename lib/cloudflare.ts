import "server-only";

// Cloudflare Email Service transport + Email Routing provisioning.
//
// Outbound: POST /accounts/<account_id>/email/sending/send with a bearer token.
// No SMTP is involved, and Cloudflare handles SPF/DKIM signing, bounce handling
// and its own suppression list. The sending domain must be onboarded under
// Cloudflare Email Sending first (Workers Paid for arbitrary recipients).
//
// Inbound (optional): Cloudflare Email Routing receives mail at the domain's MX
// and forwards a literal address to a verified destination inbox. We only
// create the routing rule; Cloudflare owns the MX/SPF/DKIM records and the
// actual mailbox. This is why a user can have a real address without any SMTP
// server on our side.
//
// API docs:
//   https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
//   https://developers.cloudflare.com/api/resources/email_routing/

const API_BASE = (
  process.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4"
).replace(/\/$/, "");

const REQUEST_TIMEOUT_MS = Number(process.env.CLOUDFLARE_TIMEOUT_MS || 15_000);

export type CloudflareCredentials = {
  accountId: string;
  apiToken: string;
};

// Per-key credentials win; the environment fallbacks let one Cloudflare
// account back several access keys without copying the token into every row.
export function cloudflareCredentials(input: {
  cloudflareAccountId?: string | null;
  cloudflareApiToken?: string | null;
}): CloudflareCredentials {
  return {
    accountId: (input.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || "").trim(),
    apiToken: (input.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN || "")
      .trim()
      .replace(/^Bearer\s+/i, ""),
  };
}

type CloudflareError = { code: number; message: string };

type CloudflareEnvelope<T> = {
  success: boolean;
  result: T | null;
  errors?: CloudflareError[];
  messages?: CloudflareError[];
};

function errorMessage(errors: CloudflareError[] | undefined, fallback: string): string {
  const first = errors?.find((e) => e?.message);
  if (!first) return fallback;
  return first.code ? `${first.message} (${first.code})` : first.message;
}

async function cfRequest<T>(
  apiToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!apiToken) throw new Error("A Cloudflare API token is required.");

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  let body: CloudflareEnvelope<T> | null = null;
  try {
    body = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
  } catch {
    body = null;
  }

  if (!res.ok || !body?.success) {
    throw new Error(
      errorMessage(body?.errors, `Cloudflare API request failed (${res.status} ${res.statusText})`),
    );
  }
  return body.result as T;
}

// ---------------------------------------------------------------- sending ---

export type CloudflareSendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  perRecipientRef: Record<string, string>;
};

type CloudflareSendResponse = {
  delivered?: string[];
  message_id?: string;
  permanent_bounces?: string[];
  queued?: string[];
  suppressed_recipients?: string[];
};

export async function sendViaCloudflare(
  credentials: CloudflareCredentials,
  params: {
    to: string[];
    from: string;
    fromName?: string | null;
    replyTo?: string | null;
    subject: string;
    html?: string | null;
    text?: string | null;
    headers?: Record<string, string>;
  },
): Promise<CloudflareSendResult> {
  if (!credentials.accountId) {
    throw new Error("A Cloudflare account ID is required for Email Sending.");
  }

  const payload = {
    from: params.fromName ? `${params.fromName} <${params.from}>` : params.from,
    to: params.to,
    subject: params.subject,
    ...(params.html ? { html: params.html } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    ...(params.headers && Object.keys(params.headers).length
      ? { headers: params.headers }
      : {}),
  };

  const result = await cfRequest<CloudflareSendResponse>(
    credentials.apiToken,
    `/accounts/${encodeURIComponent(credentials.accountId)}/email/sending/send`,
    { method: "POST", body: JSON.stringify(payload) },
  );

  const messageId = (result.message_id || "").trim().replace(/^</, "").replace(/>$/, "");
  const bounced = new Set(result.permanent_bounces || []);
  const suppressed = new Set(result.suppressed_recipients || []);
  const accepted = new Set([...(result.delivered || []), ...(result.queued || [])]);

  for (const email of params.to) {
    if (bounced.has(email)) {
      throw new Error(`Cloudflare permanently bounced ${email}`);
    }
    if (suppressed.has(email)) {
      throw new Error(`Cloudflare suppressed ${email}`);
    }
    // An empty result group should not happen on a successful send, but if it
    // does we still treat the message as accepted rather than inventing a
    // bounce we cannot prove.
    if (!accepted.has(email) && accepted.size > 0) {
      throw new Error(`Cloudflare did not accept ${email}`);
    }
  }

  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const email of params.to) {
    perRecipient[email] = messageId;
    perRecipientRef[email] = messageId;
  }
  return { messageId, perRecipient, perRecipientRef };
}

// ---------------------------------------------------------------- routing ---

export type RoutingDnsRecord = {
  type?: string | null;
  name?: string | null;
  content?: string | null;
  priority?: number | null;
  ttl?: number | null;
};

type CloudflareZone = { id: string; name: string };

type RoutingSettings = {
  id: string;
  enabled: boolean;
  name: string;
  status?: string | null;
};

type RoutingAction = { type: "drop" | "forward" | "worker"; value?: string[] };
type RoutingMatcher = { type: "all" | "literal"; field?: "to"; value?: string };
type RoutingRule = {
  id?: string;
  actions?: RoutingAction[];
  matchers?: RoutingMatcher[];
  enabled?: boolean;
  name?: string;
  priority?: number;
};

type DestinationAddress = {
  id?: string;
  email?: string;
  verified?: string | null;
};

export type CloudflareRoutingResult = {
  zoneId: string;
  status: "active" | "pending_verification" | "manual";
  ruleId: string | null;
  destinationVerified: boolean;
  records: RoutingDnsRecord[];
  settingsStatus: string | null;
  note: string | null;
};

export async function resolveZoneId(apiToken: string, domain: string): Promise<string> {
  const zones = await cfRequest<CloudflareZone[]>(
    apiToken,
    `/zones?name=${encodeURIComponent(domain)}&per_page=1`,
  );
  const zone = zones?.[0];
  if (!zone?.id) {
    throw new Error(
      `Cloudflare zone not found for ${domain}. Add the domain to Cloudflare and use a token with Zone:Read.`,
    );
  }
  return zone.id;
}

async function getRoutingSettings(apiToken: string, zoneId: string): Promise<RoutingSettings> {
  return cfRequest<RoutingSettings>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/email/routing`,
  );
}

async function enableRouting(apiToken: string, zoneId: string): Promise<RoutingSettings> {
  // `POST /email/routing/enable` is marked deprecated in the API reference but
  // remains the documented way to add and lock the MX/SPF records. Callers fall
  // back to manual setup if Cloudflare rejects it.
  return cfRequest<RoutingSettings>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/email/routing/enable`,
    { method: "POST" },
  );
}

async function getRoutingDns(apiToken: string, zoneId: string): Promise<RoutingDnsRecord[]> {
  const records = await cfRequest<RoutingDnsRecord[]>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/email/routing/dns`,
  );
  return (records || [])
    .filter((r) => r?.type && r?.name && r?.content)
    .map((r) => ({
      type: r.type,
      name: r.name,
      content: r.content,
      priority: r.priority ?? null,
      ttl: r.ttl ?? null,
    }));
}

async function listRules(apiToken: string, zoneId: string): Promise<RoutingRule[]> {
  return cfRequest<RoutingRule[]>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/email/routing/rules?per_page=50`,
  );
}

function ruleMatches(rule: RoutingRule, address: string): boolean {
  return Boolean(
    rule.matchers?.some(
      (m) => m.type === "literal" && m.field === "to" && (m.value || "").toLowerCase() === address.toLowerCase(),
    ),
  );
}

async function ensureDestinationAddress(
  apiToken: string,
  accountId: string,
  email: string,
): Promise<{ verified: boolean; created: boolean }> {
  const addresses = await cfRequest<DestinationAddress[]>(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/email/routing/addresses?per_page=50`,
  );
  const existing = (addresses || []).find(
    (a) => (a.email || "").toLowerCase() === email.toLowerCase(),
  );
  if (existing) return { verified: Boolean(existing.verified), created: false };

  const created = await cfRequest<DestinationAddress>(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/email/routing/addresses`,
    { method: "POST", body: JSON.stringify({ email }) },
  );
  return { verified: Boolean(created?.verified), created: true };
}

async function createRule(
  apiToken: string,
  zoneId: string,
  opts: { address: string; forwardTo: string; name?: string | null },
): Promise<RoutingRule> {
  return cfRequest<RoutingRule>(
    apiToken,
    `/zones/${encodeURIComponent(zoneId)}/email/routing/rules`,
    {
      method: "POST",
      body: JSON.stringify({
        actions: [{ type: "forward", value: [opts.forwardTo] }],
        matchers: [{ type: "literal", field: "to", value: opts.address }],
        enabled: true,
        name: opts.name || `EVM Sentinel → ${opts.address}`,
        source: "api",
      }),
    },
  );
}

// Creates (or repairs) the inbound half of a Cloudflare email setup:
//   1. resolve the zone,
//   2. enable Email Routing if it is off,
//   3. make sure the forwarding destination exists and is verified,
//   4. create the literal-address routing rule once the destination is verified,
//   5. cache the DNS records Cloudflare reports.
//
// A destination that Cloudflare has not verified yet is not an error: the first
// call sends the verification email, and re-running the action after the user
// clicks it creates the rule.
export async function provisionCloudflareRouting(input: {
  credentials: CloudflareCredentials;
  domain: string;
  zoneId?: string | null;
  address: string;
  forwardTo: string;
  name?: string | null;
}): Promise<CloudflareRoutingResult> {
  const { credentials, domain, address, forwardTo } = input;
  if (!credentials.accountId) {
    throw new Error("A Cloudflare account ID is required for Email Routing.");
  }

  const zoneId = (input.zoneId || "").trim() || (await resolveZoneId(credentials.apiToken, domain));

  let settings = await getRoutingSettings(credentials.apiToken, zoneId);
  if (!settings.enabled) {
    settings = await enableRouting(credentials.apiToken, zoneId);
  }

  const destination = await ensureDestinationAddress(
    credentials.apiToken,
    credentials.accountId,
    forwardTo,
  );

  const rules = await listRules(credentials.apiToken, zoneId);
  let rule = rules.find((r) => ruleMatches(r, address)) || null;

  if (!rule && destination.verified) {
    rule = await createRule(credentials.apiToken, zoneId, {
      address,
      forwardTo,
      name: input.name,
    });
  }

  let records: RoutingDnsRecord[] = [];
  try {
    records = await getRoutingDns(credentials.apiToken, zoneId);
  } catch {
    // The rule is what matters; DNS can be re-read later from the Cloudflare
    // dashboard. Do not fail provisioning because the records endpoint is
    // temporarily unavailable.
  }

  const status: CloudflareRoutingResult["status"] = rule
    ? "active"
    : destination.verified
      ? "manual"
      : "pending_verification";

  const note = rule
    ? null
    : destination.verified
      ? "The destination is verified, but Cloudflare did not create the routing rule. Check the token's Email Routing Rules permission."
      : destination.created
        ? `Cloudflare sent a verification email to ${forwardTo}. Verify that address, then re-check the routing setup.`
        : `Cloudflare still shows ${forwardTo} as unverified. Verify the destination address, then re-check.`;

  return {
    zoneId,
    status,
    ruleId: rule?.id ?? null,
    destinationVerified: destination.verified,
    records,
    settingsStatus: settings.status ?? null,
    note,
  };
}
