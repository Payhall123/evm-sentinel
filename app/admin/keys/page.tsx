import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Badge, Card, type Tone } from "@/components/ui";
import { KeyCardActions } from "@/components/key-card-actions";
import { MailboxDetails } from "@/components/mailbox-details";
import { CloudflareRoutingPanel } from "@/components/cloudflare-routing-panel";
import { CloudflareInboundForm } from "@/components/cloudflare-inbound-form";
import { SmtpEndpointsManager } from "@/components/smtp-endpoints-manager";
import { sesSmtpHost } from "@/lib/ses";

export const dynamic = "force-dynamic";

export default async function AdminKeysPage() {
  await requireAdmin();
  const keys = await prisma.accessKey.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { campaigns: true } },
      smtpEndpoints: { orderBy: { createdAt: "asc" } },
    },
  });

  const tone = (s: string): Tone =>
    s === "active" ? "green" : s === "revoked" ? "red" : s === "dns_pending" ? "amber" : "cyan";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Access keys</h1>
          <p className="text-sm text-zinc-500">Create access keys, then provision a Postal domain, choose Devner, attach Amazon SES credentials, add an Elastic Email / Resend / Mailgun / Bird API key, set up Cloudflare Email Service (REST sending + optional Email Routing), configure ZeptoMail (Zoho CPaaS) SMTP, or configure custom SMTP (e.g., Spacemail).</p>
        </div>
        <Link href="/admin/keys/new" className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
          New access key
        </Link>
      </div>

      <div className="space-y-3">
        {keys.map((k) => {
          const dns = (k.dnsRecords || {}) as { spf?: string; dkim?: string; mx?: string; dkimName?: string; dmarc?: string };
          return (
            <Card key={k.id}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-white">{k.name}</p>
                  <p className="text-sm text-zinc-500">
                    {k.domain} · {k.email || "no email"} · {k._count.campaigns} campaign(s)
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={
                      k.provider === "devner"
                        ? "cyan"
                        : k.provider === "ses"
                          ? "amber"
                          : k.provider === "elasticemail"
                            ? "green"
                            : k.provider === "resend"
                              ? "cyan"
                              : k.provider === "mailgun"
                                ? "green"
                                : k.provider === "bird"
                                  ? "cyan"
                                : k.provider === "zeptomail"
                                  ? "cyan"
                                  : k.provider === "cloudflare"
                                    ? "cyan"
                                    : k.provider === "smtp" || k.provider === "custom"
                                      ? "green"
                                      : "zinc"
                    }
                  >
                    {k.provider === "devner"
                      ? "Devner"
                      : k.provider === "ses"
                        ? "Amazon SES"
                        : k.provider === "elasticemail"
                          ? "Elastic Email"
                          : k.provider === "resend"
                            ? "Resend"
                            : k.provider === "mailgun"
                              ? "Mailgun"
                              : k.provider === "bird"
                                ? "Bird"
                              : k.provider === "zeptomail"
                                ? "ZeptoMail"
                                : k.provider === "cloudflare"
                                  ? "Cloudflare"
                                  : k.provider === "smtp" || k.provider === "custom"
                                    ? "Custom SMTP"
                                    : "Postal"}
                  </Badge>
                  <Badge tone={tone(k.status)}>{k.status}</Badge>
                  {k.provider === "postal" && k.sendMode && k.sendMode !== "api" && (
                    <Badge tone="cyan">{k.sendMode === "both" ? "domain + mailbox" : "mailbox"}</Badge>
                  )}
                  {k.provider === "ses" && (
                    <Badge tone="cyan">
                      {k.sendMode === "both" ? "api + smtp" : k.sendMode === "smtp" ? "smtp" : "api"}
                    </Badge>
                  )}
                  {k.status === "active" ? (
                    <span className="rounded bg-emerald-500/15 px-2 py-1 font-mono text-xs text-emerald-300">{k.key}</span>
                  ) : (
                    <span className="rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-400">••••</span>
                  )}
                  <KeyCardActions
                    accessKeyId={k.id}
                    keyValue={k.key}
                    status={k.status}
                    dailyLimit={k.dailyLimit}
                    expiresAt={k.expiresAt}
                  />
                </div>
              </div>
              {k.status === "dns_pending" && dns.spf && (
                <div className="mt-4 space-y-2 rounded-lg bg-zinc-950 p-4 text-xs">
                  <DnsRow type="MX" host={`@`} value={dns.mx} />
                  <DnsRow type="TXT" host={`@`} value={dns.spf} />
                  <DnsRow type="TXT" host={dns.dkimName || "postal-XXXX._domainkey"} value={dns.dkim} />
                  <DnsRow type="TXT" host={"_dmarc"} value={dns.dmarc} />
                  <p className="mt-3 text-zinc-500">
                    Add these records at your DNS provider, then the customer can send from{" "}
                    <span className="text-cyan-300">anything@{k.domain}</span>. Sending already works, but delivery improves once
                    these resolve.
                  </p>
                </div>
              )}
              {(k.status === "active" || k.status === "dns_pending") && k.postalOrg && (
                <p className="mt-3 text-xs text-zinc-600">
                  Postal: {k.postalOrg} / {k.postalServer}
                </p>
              )}
              {k.provider === "devner" && (
                <p className="mt-3 text-xs text-zinc-600">
                  Devner relay · sends from addresses @{k.domain}
                  {k.devnerApiKey ? " (per-key API key)" : " (shared server key)"}
                </p>
              )}
              {k.provider === "elasticemail" && (
                <p className="mt-3 text-xs text-zinc-600">
                  Elastic Email API · sends from addresses @{k.domain}
                  {k.elasticEmailApiKey
                    ? " · per-user API key"
                    : " · shared server key (ELASTICEMAIL_API_KEY)"}
                </p>
              )}
              {k.provider === "resend" && (
                <p className="mt-3 text-xs text-zinc-600">
                  Resend API · sends from addresses @{k.domain}
                  {k.resendApiKey ? " · per-user API key" : " · shared server key (RESEND_API_KEY)"}
                </p>
              )}
              {k.provider === "bird" && (
                <p className="mt-3 text-xs text-zinc-600">
                  Bird API · sends from addresses @{k.domain}
                  {k.birdApiKey ? " · per-user API key" : " · shared server key (BIRD_API_KEY)"}
                </p>
              )}
              {k.provider === "mailgun" && (
                <p className="mt-3 text-xs text-zinc-600">
                  Mailgun API · sends from addresses @{k.domain}
                  {k.mailgunApiKey ? " · per-user API key" : " · shared server key (MAILGUN_API_KEY)"}
                  {k.mailgunApiBase ? ` · ${k.mailgunApiBase}` : ""}
                  {k.mailgunWebhookAt ? " · delivery events active" : " · webhook registers on first send"}
                </p>
              )}
              {k.provider === "zeptomail" && (
                <>
                  <p className="mt-3 text-xs text-zinc-600">
                    ZeptoMail (Zoho CPaaS) SMTP · sends from addresses @{k.domain}
                  </p>
                  {k.smtpHost && k.smtpPassword && (
                    <MailboxDetails
                      label="ZeptoMail SMTP"
                      mailbox="ZeptoMail Mail Agent"
                      host={k.smtpHost}
                      port={k.smtpPort || 587}
                      username={k.smtpUsername}
                      password={k.smtpPassword}
                    />
                  )}
                </>
              )}
              {(k.provider === "smtp" || k.provider === "custom") && (
                <>
                  <p className="mt-3 text-xs text-zinc-600">
                    Custom SMTP{(() => {
                      const active = k.smtpEndpoints.filter((e) => e.active).length;
                      return active > 1
                        ? ` — rotating across ${active} active server${active === 1 ? "" : "s"}` + (k.smtpHost ? ` (primary ${k.smtpHost}:${k.smtpPort})` : "")
                        : k.smtpHost
                          ? ` — ${k.smtpHost}:${k.smtpPort}`
                          : ` — ${k.smtpEndpoints.length ? "no active servers" : "no servers configured"}`;
                    })()}
                  </p>
                  <SmtpEndpointsManager
                    accessKeyId={k.id}
                    endpoints={k.smtpEndpoints.map((e) => ({
                      id: e.id,
                      label: e.label,
                      host: e.host,
                      port: e.port,
                      username: e.username,
                      active: e.active,
                      failCount: e.failCount,
                      disabledAt: e.disabledAt ? e.disabledAt.toISOString() : null,
                    }))}
                  />
                </>
              )}
              {k.provider === "ses" && k.sesRegion && (
                <>
                  <p className="mt-3 text-xs text-zinc-600">
                    Amazon SES · {k.sesRegion}
                    {k.sesConfigurationSet ? ` · config set ${k.sesConfigurationSet}` : ""} · sends from addresses @
                    {k.domain}
                    {k.sendMode === "both" ? " · API transport + SMTP credentials" : ""}
                  </p>
                  {k.sendMode !== "api" && k.sesSmtpPassword && (
                    <MailboxDetails
                      label="Amazon SES SMTP"
                      mailbox={`SES ${k.sesRegion}`}
                      host={sesSmtpHost(k.sesRegion)}
                      port={k.sesSmtpPort || 587}
                      username={k.sesSmtpUsername || k.sesAccessKeyId}
                      password={k.sesSmtpPassword}
                    />
                  )}
                </>
              )}
              {k.provider === "cloudflare" && (
                <>
                  <p className="mt-3 text-xs text-zinc-600">
                    Cloudflare Email Service · REST API (no SMTP) · sends from addresses @{k.domain}
                    {k.cloudflareApiToken ? " · per-key API token" : " · server API token"}
                  </p>
                  {k.inboxAddress ? (
                    <CloudflareRoutingPanel
                      accessKeyId={k.id}
                      inboxAddress={k.inboxAddress}
                      forwardTo={k.inboundForwardTo}
                      status={k.emailRoutingStatus}
                      records={
                        (k.emailRoutingRecords as
                          | { type?: string | null; name?: string | null; content?: string | null; priority?: number | null }[]
                          | null) || []
                      }
                      note={k.emailRoutingNote}
                      error={k.emailRoutingError}
                      checkedAt={k.emailRoutingCheckedAt ? k.emailRoutingCheckedAt.toISOString() : null}
                    />
                  ) : (
                    <>
                      <p className="mt-2 text-xs text-zinc-600">
                        Outbound only. Add an inbox address below if the user also needs to receive mail.
                      </p>
                      <CloudflareInboundForm accessKeyId={k.id} domain={k.domain} />
                    </>
                  )}
                </>
              )}
              {k.provider === "postal" && k.smtpMailbox && k.smtpHost && (
                <MailboxDetails
                  mailbox={k.smtpMailbox}
                  host={k.smtpHost}
                  port={k.smtpPort || 587}
                  username={k.smtpUsername}
                  password={k.smtpPassword}
                />
              )}
            </Card>
          );
        })}
        {!keys.length && (
          <p className="rounded-xl border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
            No access keys yet. Create the first one.
          </p>
        )}
      </div>
    </div>
  );
}

function DnsRow({ type, host, value }: { type: string; host: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[3rem_10rem_1fr] gap-2">
      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-center font-semibold text-zinc-300">{type}</span>
      <code className="truncate text-zinc-400">{host}</code>
      <code className="break-all text-zinc-300">{value}</code>
    </div>
  );
}