"use client";

import { useEffect, useState, useTransition } from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { createAccessKeyAction, listPostalMailboxesAction } from "@/app/actions/admin";
import { Button, cn, Input, Label, Select } from "@/components/ui";

type Option = { ref: string; label: string; domains: string[] };

const MODES = [
  { value: "api", title: "Postal domain (API)", body: "Provision a new domain + HTTP API credential. The original flow." },
  { value: "smtp", title: "SMTP mailbox", body: "Attach an existing Postal SMTP mailbox as the customer's resource." },
  { value: "both", title: "Domain + mailbox", body: "Provision a new domain and attach a Postal SMTP mailbox." },
];

const SES_MODES = [
  { value: "api", title: "SES API", body: "Send through the Amazon SES v2 API using the IAM credentials." },
  { value: "smtp", title: "SES SMTP", body: "Send through the SES SMTP endpoint using SMTP credentials." },
  { value: "both", title: "API + SMTP", body: "Send through the API and expose the SMTP credentials to the customer." },
];

const PROVIDERS = [
  { value: "postal", title: "Postal", body: "Self-hosted Postal: a provisioned domain, or an attached SMTP mailbox." },
  { value: "devner", title: "Devner", body: "Relay through Devner (Gmail-backed). Uses a Devner API key." },
  { value: "ses", title: "Amazon SES", body: "Send through the customer's own Amazon SES account (API or SMTP)." },
  { value: "elasticemail", title: "Elastic Email", body: "Send through the customer's own Elastic Email account via its HTTP API." },
  { value: "resend", title: "Resend", body: "Send through the customer's own Resend account via its HTTP API." },
  { value: "cloudflare", title: "Cloudflare Email Service", body: "Send through Cloudflare's REST API (no SMTP) and optionally receive mail with Email Routing." },
  { value: "mailgun", title: "Mailgun", body: "Send through the customer's own Mailgun account and sending domain via its HTTP API." },
  { value: "zeptomail", title: "ZeptoMail (Zoho CPaaS)", body: "Send through Zoho CPaaS / ZeptoMail SMTP using a Mail Agent's SMTP credentials." },
  { value: "smtp", title: "Custom SMTP", body: "Send through any SMTP provider (e.g., Spacemail)." },
];

// ZeptoMail (now Zoho CPaaS) publishes a fixed SMTP submission endpoint. Mail
// Agents authenticate with the username/password shown in their ZeptoMail
// console; the relay itself never changes per account.
const ZEPTOMAIL_SMTP_HOST = "smtp.zeptomail.com";
const ZEPTOMAIL_SMTP_PORT = "587";

// One row in the multi-SMTP editor.
type SmtpEntry = { label: string; host: string; port: string; username: string; password: string };

function emptySmtpEntry(): SmtpEntry {
  return { label: "", host: "", port: "587", username: "", password: "" };
}

// Only fully-filled entries are submitted; partial rows are ignored so an
// empty extra row (from clicking "add") does not break the form.
function completeSmtpEntries(entries: SmtpEntry[]) {
  return entries
    .filter((e) => e.host.trim() && e.username.trim() && e.password.trim())
    .map((e) => ({ label: e.label.trim() || null, host: e.host.trim(), port: Number(e.port) || 587, username: e.username.trim(), password: e.password }));
}

export function NewAccessKeyForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState(createAccessKeyAction, undefined);
  const [provider, setProvider] = useState("postal");
  const [sendMode, setSendMode] = useState("api");
  const [mailboxSource, setMailboxSource] = useState("existing");
  const [mailboxes, setMailboxes] = useState<Option[]>([]);
  const [servers, setServers] = useState<Option[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [ref, setRef] = useState("");
  const [target, setTarget] = useState("");
  const [domain, setDomain] = useState("");
  const [smtpEntries, setSmtpEntries] = useState<SmtpEntry[]>([emptySmtpEntry()]);
  const [zeptomail, setZeptomail] = useState({ username: "", password: "" });
  const [cfInbound, setCfInbound] = useState(false);

  const isDevner = provider === "devner";
  const isSes = provider === "ses";
  const isElasticEmail = provider === "elasticemail";
  const isResend = provider === "resend";
  const isCloudflare = provider === "cloudflare";
  const isMailgun = provider === "mailgun";
  const isZeptomail = provider === "zeptomail";
  const isCustomSmtp = provider === "smtp" || provider === "custom";
  const isSmtpProvider = isCustomSmtp || isZeptomail;
  const isApiOnly = isDevner || isElasticEmail || isResend || isCloudflare || isMailgun;
  const wantsApi = !isApiOnly && !isSmtpProvider && sendMode !== "smtp";
  const wantsSmtp = !isApiOnly && !isSmtpProvider && sendMode !== "api";
  // SES, Elastic Email, Resend, Mailgun, ZeptoMail and custom SMTP always need a
  // verified domain for the from-address, even in SMTP mode (unlike Postal,
  // where SMTP-only keys inherit the mailbox domain).
  const domainRequired = isDevner || isSes || isElasticEmail || isResend || isCloudflare || isMailgun || isSmtpProvider || wantsApi;
  const modes = isSes ? SES_MODES : MODES;

  useEffect(() => {
    if (!wantsSmtp || isSes || mailboxes.length || servers.length) return;
    startLoading(async () => {
      const res = await listPostalMailboxesAction();
      setMailboxes(res.mailboxes);
      setServers(res.servers);
      setLoadError(res.error || null);
    });
  }, [wantsSmtp, isSes, mailboxes.length, servers.length]);

  // Prefill the sending domain from whichever Postal resource was picked.
  function pickMailbox(value: string) {
    setRef(value);
    const chosen = mailboxes.find((m) => m.ref === value);
    if (chosen?.domains[0]) setDomain(chosen.domains[0]);
  }

  function pickTarget(value: string) {
    setTarget(value);
    const chosen = servers.find((s) => s.ref === value);
    if (chosen?.domains[0]) setDomain(chosen.domains[0]);
  }

  return (
    <div>
      <form action={action} className="space-y-4">
        <div>
          <Label>Name / customer</Label>
          <Input name="name" required placeholder="Acme Corp" />
        </div>
        <div>
          <Label>Customer email (optional)</Label>
          <Input name="email" type="email" placeholder="owner@acme.com" />
        </div>

        <fieldset>
          <Label>Send via</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((o) => (
              <label
                key={o.value}
                className={cn(
                  "cursor-pointer rounded-lg border p-3 transition-colors",
                  provider === o.value ? "border-cyan-500 bg-cyan-500/10" : "border-zinc-700 bg-zinc-900 hover:border-zinc-600",
                )}
              >
                <input
                  type="radio"
                  name="provider"
                  value={o.value}
                  checked={provider === o.value}
                  onChange={() => setProvider(o.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium text-zinc-100">{o.title}</span>
                <span className="mt-1 block text-xs text-zinc-500">{o.body}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {!isDevner && !isElasticEmail && !isResend && !isMailgun && !isSmtpProvider && (
        <fieldset>
          <Label>{isSes ? "SES credential mode" : "Sending resource"}</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {modes.map((o) => (
              <label
                key={o.value}
                className={cn(
                  "cursor-pointer rounded-lg border p-3 transition-colors",
                  sendMode === o.value ? "border-cyan-500 bg-cyan-500/10" : "border-zinc-700 bg-zinc-900 hover:border-zinc-600",
                )}
              >
                <input
                  type="radio"
                  name="sendMode"
                  value={o.value}
                  checked={sendMode === o.value}
                  onChange={() => setSendMode(o.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium text-zinc-100">{o.title}</span>
                <span className="mt-1 block text-xs text-zinc-500">{o.body}</span>
              </label>
            ))}
          </div>
        </fieldset>
        )}
        {isSmtpProvider && (
          <input type="hidden" name="sendMode" value="smtp" />
        )}

        {isDevner && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <p className="text-sm font-medium text-zinc-300">Devner relay</p>
            <div>
              <Label>Devner API key (optional)</Label>
              <Input name="devnerApiKey" placeholder="sl_… (leave empty to use the server default)" />
              <p className="mt-1 text-xs text-zinc-500">
                Sends from this key&apos;s from-address through Devner. That address must be a Gmail account
                connected to the Devner account. Leave empty to use the server&apos;s DEVNER_API_KEY.
              </p>
            </div>
          </div>
        )}

        {isElasticEmail && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">Elastic Email API</p>
              <p className="mt-1 text-xs text-zinc-500">
                Add the API key for this user&apos;s Elastic Email account. It is stored on the access key and sent
                as the <code className="text-cyan-300">X-ElasticEmail-ApiKey</code> header. The key needs the{" "}
                <code className="text-cyan-300">SendHttp</code> access level.
              </p>
            </div>
            <div>
              <Label>Elastic Email API key</Label>
              <Input
                name="elasticEmailApiKey"
                type="password"
                required
                placeholder="A03B…"
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Create or copy the key in Elastic Email under Settings → API keys. Each access key can use a
                different Elastic Email account.
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              The sending domain must already be verified in that Elastic Email account (SPF, DKIM and the tracking
              CNAME).
            </p>
          </div>
        )}

        {isResend && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">Resend API</p>
              <p className="mt-1 text-xs text-zinc-500">
                Add the API key for this user&apos;s Resend account. It is stored on the access key and sent as an{" "}
                <code className="text-cyan-300">Authorization: Bearer</code> token. A sending-only key is enough.
              </p>
            </div>
            <div>
              <Label>Resend API key</Label>
              <Input
                name="resendApiKey"
                type="password"
                required
                placeholder="re_…"
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Create the key in Resend under API Keys. Each access key can use a different Resend account.
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              The sending domain must already be verified in that Resend account (DKIM + SPF records added at the
              DNS provider) or sends are rejected.
            </p>
          </div>
        )}

        {isCloudflare && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">Cloudflare Email Service · no SMTP</p>
              <p className="mt-1 text-xs text-zinc-500">
                Outbound goes through <code className="text-cyan-300">POST /accounts/&lt;id&gt;/email/sending/send</code>.
                Cloudflare signs with SPF/DKIM and handles bounces and suppression. Onboard the sending domain under
                Compute → Email Service → Email Sending first; sending to arbitrary recipients needs a Workers Paid
                plan, and new accounts start with a low daily quota.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Cloudflare account ID</Label>
                <Input
                  name="cloudflareAccountId"
                  placeholder="Leave empty to use CLOUDFLARE_ACCOUNT_ID"
                  autoComplete="off"
                />
              </div>
              <div>
                <Label>Cloudflare API token</Label>
                <Input
                  name="cloudflareApiToken"
                  type="password"
                  placeholder="Email Sending: Edit"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <p className="text-xs text-zinc-500">
              The token needs <code className="text-cyan-300">Email Sending: Edit</code>. For inbound setup also add{" "}
              <code className="text-cyan-300">Zone: Read</code>,{" "}
              <code className="text-cyan-300">Zone Settings: Write</code>,{" "}
              <code className="text-cyan-300">Email Routing Rules: Edit</code> and{" "}
              <code className="text-cyan-300">Email Routing Addresses: Edit</code>.
            </p>

            <label className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
              <input
                type="checkbox"
                checked={cfInbound}
                onChange={(e) => setCfInbound(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-200">Also receive mail for the user</span>
                <span className="mt-0.5 block text-xs text-zinc-500">
                  Cloudflare Email Routing forwards the address below to a real inbox — no SMTP mailbox is created or
                  hosted here.
                </span>
              </span>
            </label>

            {cfInbound && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Inbox address</Label>
                    <Input name="inboxAddress" placeholder="hello (or hello@acme.com)" autoComplete="off" />
                  </div>
                  <div>
                    <Label>Forward to</Label>
                    <Input
                      name="inboundForwardTo"
                      type="email"
                      placeholder="owner@gmail.com"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div>
                  <Label>Cloudflare zone ID (optional)</Label>
                  <Input name="cloudflareZoneId" placeholder="Auto-detected from the domain" autoComplete="off" />
                </div>
                <p className="text-xs text-zinc-500">
                  The domain&apos;s DNS must be on Cloudflare. Cloudflare emails a verification link to the forwarding
                  address; click it, then use “Re-check routing” on the access key. Until then the rule stays pending.
                </p>
              </div>
            )}

            <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200/90">
              Cloudflare improves authentication and bounce handling, but nobody can guarantee inbox placement. Domain
              age, sending history, engagement and complaint rate still decide whether Gmail or Outlook files a message
              as junk. Ramp volume slowly, send only to people who expect it, and keep an unsubscribe link. Cold bulk
              mail can get a Cloudflare account suspended.
            </div>
          </div>
        )}

        {isMailgun && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">Mailgun API</p>
              <p className="mt-1 text-xs text-zinc-500">
                Add the API key for this user&apos;s Mailgun account. It is stored on the access key and sent with
                HTTP Basic auth (<code className="text-cyan-300">api</code> + key) to{" "}
                <code className="text-cyan-300">/v3/&lt;domain&gt;/messages</code>.
              </p>
            </div>
            <div>
              <Label>Mailgun API key</Label>
              <Input
                name="mailgunApiKey"
                type="password"
                required
                placeholder="key-…"
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Find it in Mailgun under Settings → API keys. A sending key is enough.
              </p>
            </div>
            <div>
              <Label>API base URL (optional)</Label>
              <Input
                name="mailgunApiBase"
                defaultValue="https://api.mailgun.net"
                placeholder="https://api.mailgun.net"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Use <code className="text-cyan-300">https://api.eu.mailgun.net</code> for the EU region, or leave this
                as the default. The sending domain is entered below.
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              The sending domain must already be added in Mailgun. Sandbox domains work only for Mailgun&apos;s
              authorised recipients until the domain is upgraded.
            </p>
          </div>
        )}

        {isZeptomail && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">ZeptoMail (Zoho CPaaS) SMTP</p>
              <p className="mt-1 text-xs text-zinc-500">
                Use the SMTP credentials from a Mail Agent in ZeptoMail. The relay is fixed at{" "}
                <code className="text-cyan-300">{ZEPTOMAIL_SMTP_HOST}:{ZEPTOMAIL_SMTP_PORT}</code>{" "}
                (STARTTLS); only the username and password vary per account.
              </p>
            </div>
            <div>
              <Label>ZeptoMail SMTP username</Label>
              <Input
                name="zeptomailUsername"
                required
                value={zeptomail.username}
                onChange={(e) => setZeptomail((z) => ({ ...z, username: e.target.value }))}
                placeholder="emailappsmtp.xxxxxxxxxxxx"
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Found under Mail Agents → SMTP in the ZeptoMail console. It is usually{" "}
                <code className="text-cyan-300">emailappsmtp.…</code>.
              </p>
            </div>
            <div>
              <Label>ZeptoMail SMTP password</Label>
              <Input
                name="zeptomailPassword"
                type="password"
                required
                value={zeptomail.password}
                onChange={(e) => setZeptomail((z) => ({ ...z, password: e.target.value }))}
                placeholder="Mail Agent SMTP password"
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                ZeptoMail issues this password once when the Mail Agent is created. If it is lost, generate a new
                one instead of guessing.
              </p>
            </div>
            <p className="text-xs text-zinc-500">
              The sending domain must already be verified in ZeptoMail, and every from-address must use that domain.
              ZeptoMail rejects mail sent from an unverified domain.
            </p>
          </div>
        )}

        {isCustomSmtp && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-zinc-300">Custom SMTP servers</p>
                <p className="mt-1 text-xs text-zinc-500">
                  Add one or more SMTP providers (e.g., Spacemail). Sends rotate across all of them so no single
                  server takes every message; if one fails, the next one is used automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSmtpEntries((s) => [...s, emptySmtpEntry()])}
                className="shrink-0 rounded-lg border border-cyan-600/40 bg-cyan-600/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-600/20"
              >
                + Add SMTP server
              </button>
            </div>

            {smtpEntries.map((entry, i) => (
              <div key={i} className="relative rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                {smtpEntries.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove SMTP server ${i + 1}`}
                    onClick={() => setSmtpEntries((s) => s.filter((_, j) => j !== i))}
                    className="absolute right-2 top-2 rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  >
                    Remove
                  </button>
                )}
                <p className="mb-3 text-xs font-medium text-zinc-400">SMTP server {i + 1}{entry.label ? ` — ${entry.label}` : ""}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Label (optional)</Label>
                    <Input
                      value={entry.label}
                      onChange={(e) => setSmtpEntries((s) => s.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      placeholder="Spacemail #1"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <Label>SMTP Host</Label>
                    <Input
                      required
                      value={entry.host}
                      onChange={(e) => setSmtpEntries((s) => s.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)))}
                      placeholder="smtp.spacemail.com"
                    />
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>SMTP Port</Label>
                    <Select
                      value={entry.port}
                      onChange={(e) => setSmtpEntries((s) => s.map((x, j) => (j === i ? { ...x, port: e.target.value } : x)))}
                    >
                      <option value="587">587 — STARTTLS</option>
                      <option value="465">465 — implicit TLS</option>
                      <option value="25">25 — plain/STARTTLS</option>
                      <option value="2525">2525 — alternate STARTTLS</option>
                    </Select>
                  </div>
                  <div>
                    <Label>SMTP Username</Label>
                    <Input
                      required
                      value={entry.username}
                      onChange={(e) => setSmtpEntries((s) => s.map((x, j) => (j === i ? { ...x, username: e.target.value } : x)))}
                      placeholder="username or email"
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <Label>SMTP Password</Label>
                  <Input
                    required
                    type="password"
                    value={entry.password}
                    onChange={(e) => setSmtpEntries((s) => s.map((x, j) => (j === i ? { ...x, password: e.target.value } : x)))}
                    placeholder="password"
                    autoComplete="new-password"
                  />
                </div>
              </div>
            ))}

            <input type="hidden" name="smtpEndpoints" value={JSON.stringify(completeSmtpEntries(smtpEntries))} />
            <p className="text-xs text-zinc-500">
              Common Spacemail settings: host <code className="text-cyan-300">smtp.spacemail.com</code>, port 587 (STARTTLS) or 465 (SSL).
              Each server must accept the sending domain&apos;s from-addresses.
            </p>
          </div>
        )}

        {isSes && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <div>
              <p className="text-sm font-medium text-zinc-300">Amazon SES credentials</p>
              <p className="mt-1 text-xs text-zinc-500">
                The IAM user needs <code className="text-cyan-300">ses:SendEmail</code> and{" "}
                <code className="text-cyan-300">ses:SendRawEmail</code>. The sending domain/identity must already be
                verified in SES.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>AWS region</Label>
                <Input
                  name="sesRegion"
                  required
                  defaultValue="us-east-1"
                  placeholder="us-east-1"
                  list="ses-regions"
                  autoComplete="off"
                />
                <datalist id="ses-regions">
                  {[
                    "us-east-1",
                    "us-east-2",
                    "us-west-1",
                    "us-west-2",
                    "ca-central-1",
                    "eu-west-1",
                    "eu-west-2",
                    "eu-west-3",
                    "eu-central-1",
                    "eu-north-1",
                    "eu-south-1",
                    "ap-south-1",
                    "ap-southeast-1",
                    "ap-southeast-2",
                    "ap-northeast-1",
                    "ap-northeast-2",
                    "ap-northeast-3",
                    "sa-east-1",
                  ].map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-zinc-500">The SES region that owns the verified identity.</p>
              </div>
              <div>
                <Label>SES configuration set (optional)</Label>
                <Input name="sesConfigurationSet" placeholder="my-config-set" />
                <p className="mt-1 text-xs text-zinc-500">Used for SES event publishing (bounces, complaints, clicks).</p>
              </div>
            </div>

            <div>
              <Label>AWS access key ID</Label>
              <Input name="sesAccessKeyId" required placeholder="AKIA…" autoComplete="off" />
              <p className="mt-1 text-xs text-zinc-500">
                IAM access key with SES sending permission. Also used as the SES SMTP username by default.
              </p>
            </div>

            <div>
              <Label>AWS secret access key{sendMode === "smtp" ? " (optional)" : ""}</Label>
              <Input
                name="sesSecretAccessKey"
                type="password"
                required={sendMode !== "smtp"}
                placeholder="••••••••••••"
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Used to sign SES API requests and to derive the SMTP password. Leave the SMTP password below empty to
                derive it automatically.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>SES SMTP password (optional)</Label>
                <Input name="sesSmtpPassword" type="password" placeholder="Only if you already have SMTP credentials" autoComplete="new-password" />
                <p className="mt-1 text-xs text-zinc-500">Leave empty to derive it from the secret access key.</p>
              </div>
              <div>
                <Label>SES SMTP username (optional)</Label>
                <Input name="sesSmtpUsername" placeholder="Defaults to the access key ID" autoComplete="off" />
              </div>
            </div>

            <div>
              <Label>SES SMTP port</Label>
              <Select name="sesSmtpPort" defaultValue="587">
                <option value="587">587 — STARTTLS</option>
                <option value="465">465 — implicit TLS</option>
                <option value="25">25 — plain/STARTTLS</option>
                <option value="2465">2465 — alternate STARTTLS</option>
              </Select>
            </div>

            <p className="text-xs text-zinc-500">
              The SES SMTP endpoint is <code className="text-zinc-300">email-smtp.&lt;region&gt;.amazonaws.com</code>. API
              credentials are stored per access key so each customer sends through their own AWS account.
            </p>
          </div>
        )}

        {wantsSmtp && !isSes && (
          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
            <p className="text-sm font-medium text-zinc-300">Postal SMTP mailbox</p>

            {loading && <p className="text-xs text-zinc-500">Loading mail servers and mailboxes from Postal…</p>}
            {loadError && <p className="text-xs text-red-400">{loadError}</p>}

            {!loading && !loadError && (
              <>
                <fieldset>
                  <Label>Mailbox</Label>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: "existing", label: "Attach an existing mailbox" },
                      { value: "new", label: "Create a new mailbox" },
                    ].map((s) => (
                      <label
                        key={s.value}
                        className={cn(
                          "cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                          mailboxSource === s.value ? "border-cyan-500 bg-cyan-500/10 text-zinc-100" : "border-zinc-700 bg-zinc-900 text-zinc-400",
                        )}
                      >
                        <input
                          type="radio"
                          name="mailboxSource"
                          value={s.value}
                          checked={mailboxSource === s.value}
                          onChange={() => setMailboxSource(s.value)}
                          className="sr-only"
                        />
                        {s.label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                {mailboxSource === "existing" ? (
                  <div>
                    <Label>Mailbox to attach</Label>
                    <Select name="mailboxRef" required value={ref} onChange={(e) => pickMailbox(e.target.value)}>
                      <option value="">Select a mailbox…</option>
                      {mailboxes.map((m) => (
                        <option key={m.ref} value={m.ref}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-xs text-zinc-500">
                      {mailboxes.length
                        ? "Its SMTP password is read from Postal and revealed once after creation."
                        : "No SMTP mailboxes exist in Postal yet — choose “Create a new mailbox” instead."}
                    </p>
                  </div>
                ) : (
                  <>
                    {sendMode === "smtp" && (
                      <div>
                        <Label>Mail server</Label>
                        <Select name="mailboxTarget" required value={target} onChange={(e) => pickTarget(e.target.value)}>
                          <option value="">Select a server…</option>
                          {servers.map((s) => (
                            <option key={s.ref} value={s.ref}>
                              {s.label}
                            </option>
                          ))}
                        </Select>
                        <p className="mt-1 text-xs text-zinc-500">The mailbox credential is created on this Postal mail server.</p>
                      </div>
                    )}
                    {sendMode === "both" && (
                      <p className="text-xs text-zinc-500">The mailbox is created on the mail server provisioned for the new domain below.</p>
                    )}
                    <div>
                      <Label>Mailbox name</Label>
                      <Input name="mailboxName" required placeholder="noreply@acme.com" />
                      <p className="mt-1 text-xs text-zinc-500">A descriptive label for the credential in Postal.</p>
                    </div>
                  </>
                )}

                <div>
                  <Label>SMTP username (optional)</Label>
                  <Input name="mailboxUsername" placeholder="Defaults to the mailbox name at the sending domain" />
                  <p className="mt-1 text-xs text-zinc-500">Postal ignores the username during SMTP auth; your mail client still needs one.</p>
                </div>
              </>
            )}
          </div>
        )}

        <div>
          <Label>{isMailgun ? "Mailgun sending domain" : "Sending domain"} {domainRequired ? "" : "(optional)"}</Label>
          <Input
            name="domain"
            required={domainRequired}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={
              isDevner
                ? "gmail.com"
                : isCloudflare
                  ? "yourdomain.com"
                  : isMailgun
                    ? "sandbox…mailgun.org"
                    : isSmtpProvider
                      ? "yourdomain.com"
                      : "acme.com"
            }
          />
          <p className="mt-1 text-xs text-zinc-500">
            {isDevner
              ? "Every from-address must be on this domain and be a Gmail account connected to the Devner account."
              : isSes
                ? "This domain (or a from-address on it) must already be verified in Amazon SES. All from-addresses must use it."
                : isCloudflare
                  ? "This domain must already be onboarded for Email Sending in the same Cloudflare account. Inbound routing also needs its DNS hosted on Cloudflare."
                  : isMailgun
                    ? "This must be the domain added in Mailgun, including a sandbox domain. All from-addresses must use it."
                  : isElasticEmail || isResend
                    ? "This domain must already be verified in that provider account. All from-addresses must use it."
                    : isZeptomail
                      ? "This domain must already be verified in ZeptoMail. All from-addresses must use it."
                      : isCustomSmtp
                        ? "All from-addresses must use this domain."
                        : wantsApi
                        ? "All from-addresses must use this domain."
                        : "Auto-filled from the mailbox's server. All from-addresses must use it."}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>Daily limit</Label>
            <Input name="dailyLimit" type="number" min={0} max={10000000} step={1} placeholder="e.g. 1000 (leave empty = unlimited)" />
            <p className="mt-1 text-xs text-zinc-500">Max messages this key may send per UTC day. Editable later.</p>
          </div>
          <div>
            <Label>Expires at</Label>
            <Input name="expiresAt" type="datetime-local" placeholder="YYYY-MM-DDTHH:MM" />
            <p className="mt-1 text-xs text-zinc-500">Sends stop after this moment. Leave empty = never expires.</p>
          </div>
        </div>

        {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
        <Button type="submit" disabled={pending}>
          {pending
            ? isSes
              ? "Adding SES credentials…"
              : isElasticEmail
                ? "Adding Elastic Email key…"
                : isResend
                  ? "Adding Resend key…"
                  : isCloudflare
                    ? cfInbound
                      ? "Setting up Cloudflare sending + inbound…"
                      : "Adding Cloudflare sending…"
                    : isMailgun
                      ? "Adding Mailgun key…"
                    : isZeptomail
                      ? "Adding ZeptoMail SMTP…"
                      : isCustomSmtp
                        ? "Adding SMTP credentials…"
                        : "Provisioning…"
            : isSes
              ? "Create SES access key"
              : isElasticEmail
                ? "Create Elastic Email access key"
                : isResend
                  ? "Create Resend access key"
                  : isCloudflare
                    ? cfInbound
                      ? "Set up Cloudflare email for user"
                      : "Create Cloudflare access key"
                    : isMailgun
                      ? "Create Mailgun access key"
                    : isZeptomail
                      ? "Create ZeptoMail access key"
                      : isCustomSmtp
                        ? "Create SMTP access key"
                        : "Provision & create key"}
        </Button>
      </form>

      {state?.key && (
        <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <p className="mb-1 text-sm font-medium text-emerald-300">Access key created</p>
          <p className="text-sm text-zinc-400">
            Share this key with the customer. They sign in with their email + this key at{" "}
            <code className="text-emerald-300">/login</code>.
          </p>
          <code className="mt-3 block break-all rounded-lg bg-zinc-950 p-3 text-sm text-emerald-300 select-all">{state.key}</code>

          {state.ses && (
            <div className="mt-4 rounded-lg bg-zinc-950 p-3">
              <p className="text-sm font-medium text-emerald-300">Amazon SES credentials</p>
              <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-zinc-500">Region</dt>
                <dd className="text-zinc-200">{state.ses.region}</dd>
                <dt className="text-zinc-500">Mode</dt>
                <dd className="text-zinc-200">
                  {state.mode === "smtp" ? "SMTP" : state.mode === "both" ? "API + SMTP" : "SES API"}
                </dd>
                {state.ses.configurationSet && (
                  <>
                    <dt className="text-zinc-500">Config set</dt>
                    <dd className="break-all text-zinc-200">{state.ses.configurationSet}</dd>
                  </>
                )}
                {state.mode !== "api" && (
                  <>
                    <dt className="text-zinc-500">SMTP server</dt>
                    <dd className="break-all text-zinc-200">{state.ses.host}</dd>
                    <dt className="text-zinc-500">Port</dt>
                    <dd className="text-zinc-200">
                      {state.ses.port} {state.ses.port === 465 ? "(TLS)" : "(STARTTLS)"}
                    </dd>
                    <dt className="text-zinc-500">Username</dt>
                    <dd className="break-all text-zinc-200">{state.ses.username}</dd>
                    <dt className="text-zinc-500">Password</dt>
                    <dd className="break-all text-emerald-300 select-all">{state.ses.password}</dd>
                  </>
                )}
              </dl>
              {state.mode !== "api" && (
                <p className="mt-2 text-xs text-amber-300">
                  Copy this password now. It is stored and can be revealed again from the access key list.
                </p>
              )}
            </div>
          )}

          {state.mailbox && (
            <div className="mt-4 rounded-lg bg-zinc-950 p-3">
              <p className="text-sm font-medium text-emerald-300">SMTP mailbox credentials</p>
              <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-zinc-500">Mailbox</dt>
                <dd className="break-all text-zinc-200">{state.mailbox.name}</dd>
                <dt className="text-zinc-500">Server</dt>
                <dd className="text-zinc-200">{state.mailbox.host}</dd>
                <dt className="text-zinc-500">Port</dt>
                <dd className="text-zinc-200">{state.mailbox.port} (STARTTLS)</dd>
                <dt className="text-zinc-500">Username</dt>
                <dd className="break-all text-zinc-200">{state.mailbox.username}</dd>
                <dt className="text-zinc-500">Password</dt>
                <dd className="break-all text-emerald-300 select-all">{state.mailbox.password}</dd>
              </dl>
              <p className="mt-2 text-xs text-amber-300">Copy this password now. EVM Sentinel stores it so you can reveal it again from the access key list.</p>
            </div>
          )}

          {state.provider === "cloudflare" && state.cloudflare && (
            <div className="mt-4 rounded-lg bg-zinc-950 p-3">
              <p className="text-sm font-medium text-emerald-300">Cloudflare Email Service</p>
              <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-zinc-500">Account</dt>
                <dd className="break-all text-zinc-200">{state.cloudflare.accountId}</dd>
                <dt className="text-zinc-500">Transport</dt>
                <dd className="text-zinc-200">REST API — no SMTP</dd>
                <dt className="text-zinc-500">Domain</dt>
                <dd className="break-all text-zinc-200">{state.cloudflare.domain}</dd>
                {state.cloudflare.inboxAddress && (
                  <>
                    <dt className="text-zinc-500">Inbox</dt>
                    <dd className="break-all text-zinc-200">{state.cloudflare.inboxAddress}</dd>
                    <dt className="text-zinc-500">Forwards to</dt>
                    <dd className="break-all text-zinc-200">{state.cloudflare.forwardTo}</dd>
                    <dt className="text-zinc-500">Routing</dt>
                    <dd className="text-zinc-200">{state.cloudflare.status || "pending"}</dd>
                  </>
                )}
              </dl>
              {state.cloudflare.error && (
                <p className="mt-2 text-xs text-red-300">
                  Inbound setup failed: {state.cloudflare.error}. Outbound sending still works; fix the token
                  permissions or add the rule in the Cloudflare dashboard.
                </p>
              )}
              {state.cloudflare.note && <p className="mt-2 text-xs text-amber-300">{state.cloudflare.note}</p>}
              {state.cloudflare.records.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
                  <p className="text-xs font-medium text-zinc-400">Email Routing DNS records</p>
                  {state.cloudflare.records.map((r, i) => (
                    <div key={`${r.type}-${r.name}-${i}`} className="grid grid-cols-[3rem_8rem_1fr] gap-2 text-[11px]">
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-center font-semibold text-zinc-300">
                        {r.type}
                      </span>
                      <code className="truncate text-zinc-400">{r.name}</code>
                      <code className="break-all text-zinc-300">{r.content}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.provider === "elasticemail" && (
            <p className="mt-3 text-sm text-zinc-400">
              The user&apos;s Elastic Email API key is attached. They can send from any address on their verified
              domain.
            </p>
          )}

          {state.provider === "resend" && (
            <p className="mt-3 text-sm text-zinc-400">
              The user&apos;s Resend API key is attached. They can send from any address on their verified domain.
            </p>
          )}

          {state.provider === "mailgun" && (
            <p className="mt-3 text-sm text-zinc-400">
              The user&apos;s Mailgun API key is attached. They can send from any address on the Mailgun sending
              domain; sandbox domains only deliver to authorised recipients. Delivery events are registered with
              Mailgun automatically on the first campaign.
            </p>
          )}

          {(state.provider === "smtp" || state.provider === "custom" || state.provider === "zeptomail") && state.smtp && (
            <div className="mt-4 rounded-lg bg-zinc-950 p-3">
              <p className="text-sm font-medium text-emerald-300">
                {state.provider === "zeptomail" ? "ZeptoMail SMTP credentials" : "Custom SMTP credentials"}
                {state.smtpCount && state.smtpCount > 1 ? ` (${state.smtpCount} servers — rotation enabled)` : ""}
              </p>
              <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-zinc-500">Host</dt>
                <dd className="break-all text-zinc-200">{state.smtp.host}</dd>
                <dt className="text-zinc-500">Port</dt>
                <dd className="text-zinc-200">{state.smtp.port}</dd>
                <dt className="text-zinc-500">Username</dt>
                <dd className="break-all text-zinc-200">{state.smtp.username}</dd>
                <dt className="text-zinc-500">Password</dt>
                <dd className="break-all text-emerald-300 select-all">{state.smtp.password}</dd>
              </dl>
              {state.smtpCount && state.smtpCount > 1 ? (
                <p className="mt-2 text-xs text-cyan-300">
                  {state.smtpCount} SMTP servers attached. Campaign sends rotate across all of them; the first is shown above.
                  Manage the list on the access keys page.
                </p>
              ) : (
                <p className="mt-2 text-xs text-amber-300">Copy this password now. It is stored and can be revealed again from the access key list.</p>
              )}
            </div>
          )}

          {state.provider === "postal" && state.mode !== "smtp" && (
            <p className="mt-3 text-sm text-zinc-400">
              DNS records have been generated — they appear on the{" "}
              <button onClick={() => router.push("/admin/keys")} className="text-cyan-400 hover:underline">
                access keys
              </button>{" "}
              page.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
