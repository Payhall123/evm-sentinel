import "server-only";

const POSTAL_URL = (process.env.POSTAL_URL || "https://mail.diveru.ink").replace(/\/$/, "");
const POSTAL_EMAIL = process.env.POSTAL_ADMIN_EMAIL || "admin@diveru.ink";
const POSTAL_PASSWORD = process.env.POSTAL_ADMIN_PASSWORD || "";

// Public SMTP submission endpoint offered to customers. Postal ignores the SMTP
// username entirely (it authenticates on the credential key alone) but mail
// clients require one, so we surface a mailbox address to paste in.
const POSTAL_SMTP_HOST = process.env.POSTAL_SMTP_HOSTNAME || new URL(POSTAL_URL).hostname;
const POSTAL_SMTP_PORT = Number(process.env.POSTAL_SMTP_PORT || 587);

// In-process session state for the Postal admin web UI.
// Only one legit admin; serialised requests avoid cross-talk.
const postalCookies = new Map<string, string>();
let postalCsrf = "";
let postalLock: Promise<void> = Promise.resolve();

const UA = "Mozilla/5.0 (evmsentinel)";

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = postalLock.then(fn, fn);
  postalLock = run.then(() => undefined, () => undefined);
  return run;
}

function cookieHeader(): string {
  return [...postalCookies.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
}

function extractCsrf(html: string) {
  const m = html.match(/name="csrf-token" content="([^"]+)"|name="authenticity_token" value="([^"]+)"/);
  if (m) postalCsrf = (m[1] || m[2] || "").replace(/&quot;/g, '"');
}

function extractCookies(res: Response) {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() || [];
  const scHeader = res.headers.get("set-cookie");
  if (!setCookies.length && scHeader) setCookies.push(scHeader);
  for (const sc of setCookies) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) postalCookies.set(m[1], decodeURIComponent(m[2] || ""));
  }
}

async function postalGet(path: string): Promise<{ status: number; text: string }> {
  const url = new URL(path, POSTAL_URL).toString();
  const res = await fetch(url, {
    headers: { Cookie: cookieHeader(), "User-Agent": UA, Accept: "text/html,application/json,*/*" },
    redirect: "manual",
  });
  let text = await res.text();
  extractCookies(res);
  extractCsrf(text);
  const redirect = res.headers.get("location");
  if (res.status === 302 && redirect) {
    if (redirect.startsWith("/login") && !path.startsWith("/login")) text = "";
    else if (!redirect.startsWith("http")) {
      const r = await postalGet(redirect);
      return r;
    }
  }
  return { status: res.status, text };
}

// Inject the Rails authenticity_token on every state-changing POST.
// Login's CSRF check is enforced too (a missing/stale token returns 422), so
// ensureLogin fetches /login first to bind postalCsrf to the current session.
// For everything else (org/server/domain/credentials) the token MUST match the
// currently logged-in session or Postal rejects with 422 "The change you wanted
// was rejected". Tokens are refreshed against the authed session before each
// provisioning POST (see ensureLoginAndRefreshCsrf).
function postalPostBody(form: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams({ ...form });
  if (postalCsrf) body.set("authenticity_token", postalCsrf);
  return body;
}

async function postalPost(path: string, form: Record<string, string>, referer = "/"): Promise<{ status: number; text: string; location: string | null }> {
  const body = postalPostBody(form);
  const res = await fetch(new URL(path, POSTAL_URL).toString(), {
    method: "POST",
    headers: {
      Cookie: cookieHeader(),
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html, text/vnd.turbo-stream.html, */*",
      Referer: POSTAL_URL + referer,
    },
    body,
    redirect: "manual",
  });
  const text = await res.text();
  extractCookies(res);
  extractCsrf(text);
  return { status: res.status, text, location: res.headers.get("location") };
}

async function ensureLogin(): Promise<void> {
  const probe = await postalGet("/");
  if (!probe.text.includes("class='main'") && !probe.text.includes("siteHeader") && !/Welcome|Choose mail server|Organizations/.test(probe.text)) {
    // Fetch the login form explicitly. The logged-out probe ("/" -> /login) never
    // returns the login page body, so without this postalCsrf is stale/empty and
    // Postal rejects the login POST with 422 (CSRF is enforced on login).
    await postalGet("/login");
    await postalPost("/login", {
      email_address: POSTAL_EMAIL,
      password: POSTAL_PASSWORD,
      return_to: "/",
    });
    // Rails rotates the session on login, which invalidates any token captured
    // before it. Fetch a fresh authed page so postalCsrf is bound to the current
    // session before any org/server/domain POST.
    const authed = await postalGet("/organizations/new");
    if (!/organizations?|Organization/.test(authed.text)) throw new Error("Postal: login appeared successful but no authed page returned");
  }
}

export type DomainDnsInfo = {
  spf: string;
  dkim: string;
  dkimValue: string;
  mx: string;
  dkimName: string;
  dmarc: string;
};

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 40);
}

// ---------------------------------------------------------------------------
// Postal resource discovery: organizations -> mail servers -> credentials
// ---------------------------------------------------------------------------
// Scraped from the Postal 3.x admin UI. Class names below are pinned to
// app/views/*.html.haml in the running Postal image (verified against 3.3.7).

type ScrapedOrg = { permalink: string; name: string };
type ScrapedServer = { permalink: string; name: string };
type ScrapedCredential = { id: string; name: string; type: string; key: string };

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Each credential renders as:
//   <li class='credentialList__item'> ... /credentials/<uuid> ...
//   <span class='label label--credentialType-smtp'>SMTP</span>
//   <p class='credentialList__name'>NAME</p>
//   <p class='credentialList__key'>KEY</p>
// The key is the SMTP password (or API token) and Postal only ever exposes it here.
function parseCredentials(html: string): ScrapedCredential[] {
  const chunks = html.split("credentialList__item").slice(1);
  const out: ScrapedCredential[] = [];
  for (const chunk of chunks) {
    const id = chunk.match(/\/credentials\/([0-9a-f-]{36})/)?.[1];
    if (!id) continue;
    const type = chunk.match(/credentialType-([a-z_]+)/)?.[1]?.replace(/_/g, "-").toLowerCase() || "";
    const name = decodeEntities((chunk.match(/credentialList__name[^>]*>([\s\S]*?)<\/p>/)?.[1] || "").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    const key = decodeEntities(chunk.match(/credentialList__key[^>]*>([^<]*)<\/p>/)?.[1]?.trim() || "");
    out.push({ id, name, type, key });
  }
  return out;
}

function parseOrgs(html: string): ScrapedOrg[] {
  const out: ScrapedOrg[] = [];
  for (const chunk of html.split("largeList__item").slice(1)) {
    const permalink = chunk.match(/href="\/org\/([^"/]+)"/)?.[1];
    if (!permalink) continue;
    const name = decodeEntities((chunk.match(/largeList__link[^>]*>([^<]+)<\/a>/)?.[1] || permalink).trim());
    out.push({ permalink, name });
  }
  return out;
}

function parseServers(html: string): ScrapedServer[] {
  const out: ScrapedServer[] = [];
  for (const chunk of html.split("largeList__item").slice(1)) {
    const permalink = chunk.match(/\/servers\/([^"'/]+)/)?.[1];
    if (!permalink) continue;
    const name = decodeEntities((chunk.match(/<p>([^<]+)<\/p>/)?.[1] || permalink).trim());
    out.push({ permalink, name });
  }
  return out;
}

function parseDomains(html: string): string[] {
  const out: string[] = [];
  for (const chunk of html.split("domainList__item").slice(1)) {
    const name = decodeEntities((chunk.match(/domainList__name[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/)?.[1] || "").trim());
    if (name) out.push(name);
  }
  return out;
}

async function scrapeOrgs(): Promise<ScrapedOrg[]> {
  return parseOrgs((await postalGet("/")).text);
}

async function scrapeServers(orgPermalink: string): Promise<ScrapedServer[]> {
  return parseServers((await postalGet(`/org/${orgPermalink}`)).text);
}

async function scrapeDomains(orgPermalink: string, serverPermalink: string): Promise<string[]> {
  return parseDomains((await postalGet(`/org/${orgPermalink}/servers/${serverPermalink}/domains`)).text);
}

async function scrapeCredentials(orgPermalink: string, serverPermalink: string): Promise<ScrapedCredential[]> {
  return parseCredentials((await postalGet(`/org/${orgPermalink}/servers/${serverPermalink}/credentials`)).text);
}

export type PostalMailbox = {
  orgPermalink: string;
  serverPermalink: string;
  serverName: string;
  id: string;
  name: string;
  domains: string[];
};

export type PostalServerRef = {
  orgPermalink: string;
  serverPermalink: string;
  serverName: string;
  domains: string[];
};

export type MailboxCredential = PostalMailbox & {
  username: string;
  password: string;
  host: string;
  port: number;
};

export function smtpEndpoint(): { host: string; port: number } {
  return { host: POSTAL_SMTP_HOST, port: POSTAL_SMTP_PORT };
}

export function toMailboxCredential(mailbox: PostalMailbox, key: string, username?: string): MailboxCredential {
  const { host, port } = smtpEndpoint();
  const fallback = `${mailbox.name || "postmaster"}@${mailbox.domains[0] || host}`;
  // If username is provided, use it; else if mailbox.name looks like an email address, use it; else use fallback.
  const finalUsername = (username || "").trim()
    || (mailbox.name.includes("@") ? mailbox.name : fallback);
  return { ...mailbox, username: finalUsername, password: key, host, port };
}

// Lists every SMTP mailbox credential and mail server across all Postal
// organizations. Secrets are deliberately excluded; they are read on attach.
export async function listMailboxes(): Promise<{ mailboxes: PostalMailbox[]; servers: PostalServerRef[] }> {
  return serialized(async () => {
    await ensureLogin();
    const mailboxes: PostalMailbox[] = [];
    const servers: PostalServerRef[] = [];
    for (const org of await scrapeOrgs()) {
      for (const srv of await scrapeServers(org.permalink)) {
        const domains = await scrapeDomains(org.permalink, srv.permalink);
        servers.push({ orgPermalink: org.permalink, serverPermalink: srv.permalink, serverName: srv.name, domains });
        for (const cred of await scrapeCredentials(org.permalink, srv.permalink)) {
          if (cred.type === "smtp") {
            mailboxes.push({
              orgPermalink: org.permalink,
              serverPermalink: srv.permalink,
              serverName: srv.name,
              id: cred.id,
              name: cred.name,
              domains,
            });
          }
        }
      }
    }
    return { mailboxes, servers };
  });
}

// Creates a new SMTP credential (mailbox) on an existing mail server and reads
// the generated key back from the credentials page.
export async function createMailbox(
  orgPermalink: string,
  serverPermalink: string,
  name: string,
  username?: string,
): Promise<MailboxCredential> {
  return serialized(async () => {
    await ensureLogin();
    const path = `/org/${orgPermalink}/servers/${serverPermalink}/credentials`;
    const before = new Set((await scrapeCredentials(orgPermalink, serverPermalink)).map((c) => c.id));
    const res = await postalPost(
      path,
      { "credential[type]": "SMTP", "credential[name]": name, "credential[hold]": "false" },
      `${path}/new`,
    );
    if (res.status >= 400) throw new Error(`Postal: mailbox creation failed (${res.status})`);

    const serverName = (await scrapeServers(orgPermalink)).find((s) => s.permalink === serverPermalink)?.name || serverPermalink;
    const domains = await scrapeDomains(orgPermalink, serverPermalink);
    const after = await scrapeCredentials(orgPermalink, serverPermalink);
    const created = after.find((c) => !before.has(c.id)) || [...after].reverse().find((c) => c.type === "smtp" && c.name === name);
    if (!created?.key) throw new Error("Postal: mailbox was created but its credential could not be read back");

    return toMailboxCredential({ orgPermalink, serverPermalink, serverName, id: created.id, name: created.name || name, domains }, created.key, username);
  });
}

// Attaches an existing SMTP credential (mailbox) by reading its key.
export async function attachMailbox(mailbox: PostalMailbox, username?: string): Promise<MailboxCredential> {
  return serialized(async () => {
    await ensureLogin();
    const cred = (await scrapeCredentials(mailbox.orgPermalink, mailbox.serverPermalink)).find((c) => c.id === mailbox.id);
    if (!cred) throw new Error("Postal: the selected mailbox could not be found");
    if (!cred.key) throw new Error("Postal: the selected mailbox has no credential key");
    return toMailboxCredential({ ...mailbox, name: mailbox.name || cred.name }, cred.key, username);
  });
}

// Provisions a fresh Postal organization + mail server + domain for one customer.
// Returns everything the app needs, including DNS records the customer must add.
export async function provisionDomain(domain: string, label: string): Promise<{
  orgPermalink: string;
  serverPermalink: string;
  domainId: string;
  apiKey: string;
  dns: DomainDnsInfo;
}> {
  return serialized(async () => {
    await ensureLogin();

    const orgPermalink = slug(label || domain).replace(/[^a-z0-9]/g, "") || "evms";
    const uniq = Date.now().toString(36).slice(-5);
    const orgName = `${orgPermalink}${uniq}`;
    const orgSlug = orgName;
    const serverPermalink = `${orgName}-srv`;

    // 1. Organization
    const orgRes = await postalPost("/organizations", {
      "organization[name]": orgName,
      "organization[permalink]": orgSlug,
    }, "/organizations/new");
    if (orgRes.status >= 400) throw new Error(`Postal: org creation failed (${orgRes.status})`);

    const actualOrg = orgRes.location?.match(/\/org\/([^/]+)/)?.[1] || orgSlug;

    // 2. Mail server
    const srvRes = await postalPost(`/org/${actualOrg}/servers`, {
      "server[name]": `${label || "evmsentinel"} ${domain}`,
      "server[permalink]": serverPermalink,
      "server[mode]": "Live",
    }, `/org/${actualOrg}/servers/new`);
    if (srvRes.status >= 400) throw new Error(`Postal: server creation failed (${srvRes.status})`);

    // 3. Domain
    const domRes = await postalPost(`/org/${actualOrg}/servers/${serverPermalink}/domains`, {
      "domain[name]": domain,
    }, `/org/${actualOrg}/servers/${serverPermalink}/domains/new`);
    if (domRes.status >= 400 || !domRes.location) {
      throw new Error(`Postal: domain creation failed (${domRes.status})`);
    }

    // 4. DNS records from the setup page
    const setupPath = domRes.location;
    const setupPage = await postalGet(setupPath);

    const domainId = setupPath.split("/domains/")[1]?.split("/")[0] ||
      setupPage.text.match(/\/domains\/([0-9a-f-]{36})\//)?.[1] || "";

    const snippets = [...setupPage.text.matchAll(/<pre class='codeBlock u-margin'>([^<]*)<\/pre>/g)].map((m) => m[1].trim());
    const dkimName = setupPage.text.match(/(postal-[A-Za-z0-9]+\._domainkey)/)?.[1] || `.${domain}`;

    const dns: DomainDnsInfo = {
      spf: snippets[0] || `v=spf1 a mx include:spf.diveru.ink ~all`,
      dkim: snippets[1] || "",
      dkimValue: snippets[1] || "",
      mx: snippets[2] || "rp.diveru.ink",
      dkimName,
      // DMARC signals it to receiving providers and gives us aggregate reports to
      // prove SPF/DKIM alignment for a domain. p=none so it never blocks mail.
      dmarc: "v=DMARC1; p=none; rua=mailto:dmarc@diveru.ink;",
    };

    // 5. API credential (used for HTTP sending)
    await postalPost(`/org/${actualOrg}/servers/${serverPermalink}/credentials`, {
      "credential[type]": "API",
      "credential[name]": "evmsentinel",
      "credential[hold]": "false",
    }, `/org/${actualOrg}/servers/${serverPermalink}/credentials/new`);

    const credPage = await postalGet(`/org/${actualOrg}/servers/${serverPermalink}/credentials`);
    // Match the API credential by type/name so a co-existing SMTP mailbox key
    // (which sorts alphabetically before "evmsentinel") is never picked up.
    const apiKey =
      parseCredentials(credPage.text).find((c) => c.type === "api" && c.name === "evmsentinel" && c.key)?.key ||
      parseCredentials(credPage.text).find((c) => c.type === "api" && c.key)?.key ||
      "";

    if (!domainId || !apiKey) {
      throw new Error("Postal: provisioning incomplete (missing domain id or api key)");
    }

    return { orgPermalink: actualOrg, serverPermalink, domainId, apiKey, dns };
  });
}

// Contact the mailbox / check domain-ness once DNS is added.
export async function verifyDomain(orgPermalink: string, serverPermalink: string, domainId: string): Promise<boolean> {
  return serialized(async () => {
    await ensureLogin();
    const res = await postalPost(
      `/org/${orgPermalink}/servers/${serverPermalink}/domains/${domainId}/check`,
      { authenticity_token: postalCsrf },
      `/org/${orgPermalink}/servers/${serverPermalink}/domains/${domainId}`
    );
    return res.status < 400;
  });
}

// ---------------------------------------------------------------------------
// Delivery analytics: provider callbacks
// ---------------------------------------------------------------------------

// Public base URL this app is reachable at, used to build the webhook URL that
// Postal posts delivery events to. Falls back to the unsubscribe host, which is
// the same public origin.
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || process.env.UNSUBSCRIBE_BASE_URL || "").replace(/\/$/, "");
}

// Registers a webhook on a mail server so Postal reports delivery outcomes back
// to us. `all_events` keeps us subscribed to every event Postal emits.
// Returns the webhook uuid when it can be read back from the list page.
export async function createServerWebhook(
  orgPermalink: string,
  serverPermalink: string,
  name: string,
  url: string,
): Promise<{ id: string | null }> {
  return serialized(async () => {
    await ensureLogin();
    const path = `/org/${orgPermalink}/servers/${serverPermalink}/webhooks`;
    const res = await postalPost(
      path,
      {
        "webhook[name]": name,
        "webhook[url]": url,
        "webhook[enabled]": "true",
        "webhook[all_events]": "true",
      },
      `${path}/new`,
    );
    if (res.status >= 400) throw new Error(`Postal: webhook creation failed (${res.status})`);

    // Best-effort: read the uuid back so the caller can record it. Several
    // webhooks can share one server, so locate the row that carries this
    // webhook's own secret and take the uuid from the nearest preceding link.
    const list = await postalGet(path);
    const html = list.text;
    const needle = new URL(url).searchParams.get("k") || url;
    const at = html.indexOf(needle);
    let id: string | null = null;
    if (at >= 0) {
      const re = /\/webhooks\/([0-9a-f-]{36})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && m.index < at) id = m[1];
    }
    return { id };
  });
}

export type SendResult = {
  messageId: string;
  perRecipient: Record<string, string>;
  // Postal's per-recipient message token, used to match delivery webhooks.
  perRecipientRef: Record<string, string>;
};

export async function sendMessage(apiKey: string, params: {
  to: string[];
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  // Extra RFC 822 headers, e.g. the RFC 8058 List-Unsubscribe pair. Postal
  // accepts these verbatim on the send API.
  headers?: Record<string, string>;
}): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    to: params.to,
    from: params.fromName ? `${params.fromName} <${params.from}>` : params.from,
    subject: params.subject,
  };
  if (params.html) payload.html_body = params.html;
  if (params.text) payload.plain_body = params.text;
  if (params.replyTo) payload.reply_to = params.replyTo;
  if (params.headers && Object.keys(params.headers).length > 0) payload.headers = params.headers;

  const res = await fetch(`${POSTAL_URL}/api/v1/send/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Server-API-Key": apiKey },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== "success") {
    throw new Error(`Postal send failed (${res.status}): ${JSON.stringify(json)}`);
  }
  const data = json.data as { message_id: string; messages: Record<string, { id: number; token: string }> };
  const perRecipient: Record<string, string> = {};
  const perRecipientRef: Record<string, string> = {};
  for (const [email, meta] of Object.entries(data.messages || {})) {
    perRecipient[email] = meta.token ? `${data.message_id.split("@")[0]}@${meta.token}` : data.message_id;
    if (meta.token) perRecipientRef[email] = meta.token;
  }
  return { messageId: data.message_id, perRecipient, perRecipientRef };
}