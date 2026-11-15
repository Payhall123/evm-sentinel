import { requireUser } from "@/lib/auth";
import { Card, EmptyState } from "@/components/ui";
import { MailboxDetails } from "@/components/mailbox-details";
import { sesSmtpHost } from "@/lib/ses";

export const dynamic = "force-dynamic";

export default async function SmtpSettingsPage() {
  const { accessKey } = await requireUser();
  const isSes = accessKey.provider === "ses";
  const isCloudflare = accessKey.provider === "cloudflare";
  const isZeptomail = accessKey.provider === "zeptomail";
  const isCustomSmtp =
    accessKey.provider === "smtp" || accessKey.provider === "custom" || isZeptomail;
  const smtpLabel = isZeptomail ? "ZeptoMail (Zoho CPaaS) SMTP" : "Custom SMTP";
  const hasMailbox = Boolean(accessKey.smtpMailbox && accessKey.smtpHost);
  const hasSes = Boolean(accessKey.sesRegion);
  const hasCustom = Boolean(
    isCustomSmtp
      ? accessKey.smtpEndpoints.length > 0 || (accessKey.smtpHost && accessKey.smtpPassword)
      : false,
  );

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-semibold text-white">SMTP settings</h1>
      <p className="mb-6 text-sm text-zinc-500">
        {isSes
          ? "Send from your own tools using the Amazon SES credentials attached to your account."
          : isZeptomail
            ? "Send from your own tools using the ZeptoMail (Zoho CPaaS) SMTP credentials attached to your account."
            : isCustomSmtp
              ? "Send from your own tools using the custom SMTP credentials attached to your account."
              : accessKey.provider === "devner"
                ? "Your account sends through the hosted Devner relay, so there is no SMTP mailbox to configure."
                : accessKey.provider === "elasticemail"
                  ? "Your account sends through the Elastic Email HTTP API; EVM Sentinel manages the sends."
                  : accessKey.provider === "resend"
                    ? "Your account sends through the Resend HTTP API; EVM Sentinel manages the sends."
                    : isCloudflare
                      ? "Your account sends through Cloudflare Email Service's REST API — no SMTP — and can receive mail through Cloudflare Email Routing."
                      : accessKey.provider === "mailgun"
                        ? "Your account sends through the Mailgun HTTP API; EVM Sentinel manages the sends."
                        : "Send from your own tools using the Postal mailbox attached to your account."}
      </p>

      {isCustomSmtp ? (
        !hasCustom && accessKey.smtpEndpoints.length === 0 ? (
          <EmptyState
            title={`${smtpLabel} is not configured`}
            body={
              isZeptomail
                ? "Ask your administrator to add your ZeptoMail Mail Agent SMTP username and password to this access key."
                : "Ask your administrator to add SMTP host, port, username and password to this access key."
            }
          />
        ) : accessKey.smtpEndpoints.length > 1 ? (
          <div className="space-y-3">
            <Card>
              <p className="mb-1 text-sm font-medium text-zinc-200">
                {accessKey.smtpEndpoints.filter((e) => e.active).length} SMTP servers attached
              </p>
              <p className="text-xs text-zinc-500">
                Your campaigns rotate across these servers, spreading the sending so no single provider takes every
                message. If one server fails, the rest keep delivering.
              </p>
            </Card>
            {accessKey.smtpEndpoints.map((e, i) => (
              <Card key={e.id}>
                <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-zinc-500">Server</dt>
                  <dd className="text-zinc-100">SMTP {i + 1}{e.label ? ` — ${e.label}` : ""}</dd>
                  <dt className="text-zinc-500">Host</dt>
                  <dd className="text-zinc-100">{e.host}</dd>
                  <dt className="text-zinc-500">Port</dt>
                  <dd className="text-zinc-100">{e.port} — {e.port === 465 ? "implicit TLS" : "STARTTLS/submission"}</dd>
                  <dt className="text-zinc-500">Username</dt>
                  <dd className="break-all text-zinc-100">{e.username}</dd>
                  <dt className="text-zinc-500">Status</dt>
                  <dd className="text-zinc-100">
                    {!e.active
                      ? "Paused by your administrator"
                      : e.disabledAt && e.disabledAt.getTime() > Date.now()
                        ? "Temporarily cooling down after failures"
                        : "Active"}
                  </dd>
                  <dt className="text-zinc-500">Password</dt>
                  <dd className="text-zinc-100">Provided by your administrator</dd>
                </dl>
                <p className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                  Use these to authenticate from your own tools as well. Send from any address on{" "}
                  <span className="text-cyan-300">@{accessKey.domain}</span>.
                </p>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-zinc-500">Provider</dt>
              <dd className="text-zinc-100">{smtpLabel}</dd>
              <dt className="text-zinc-500">Server</dt>
              <dd className="text-zinc-100">{accessKey.smtpHost ?? accessKey.smtpEndpoints[0]?.host}</dd>
              <dt className="text-zinc-500">Port</dt>
              <dd className="text-zinc-100">
                {(accessKey.smtpPort ?? accessKey.smtpEndpoints[0]?.port ?? 587)} —{" "}
                {(accessKey.smtpPort ?? accessKey.smtpEndpoints[0]?.port ?? 587) === 465 ? "implicit TLS" : "STARTTLS/submission"}
              </dd>
              <dt className="text-zinc-500">Username</dt>
              <dd className="break-all text-zinc-100">{accessKey.smtpUsername ?? accessKey.smtpEndpoints[0]?.username}</dd>
              <dt className="text-zinc-500">Password</dt>
              <dd className="text-zinc-100">Provided by your administrator</dd>
            </dl>
            <div className="mt-5 space-y-2 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
              <p>Send from any address on{" "}
                <span className="text-cyan-300">@{accessKey.domain}</span>. Authenticate with the credentials above.</p>
              {isZeptomail && (
                <p>
                  ZeptoMail only accepts mail from a domain (or from-address) that is verified in your ZeptoMail
                  account.
                </p>
              )}
            </div>
          </Card>
        )
      ) : isSes ? (
        !hasSes ? (
          <EmptyState
            title="Amazon SES is not configured"
            body="Ask your administrator to add your AWS region and SES credentials to this access key."
          />
        ) : (
          <Card>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-zinc-500">Provider</dt>
              <dd className="text-zinc-100">Amazon SES</dd>
              <dt className="text-zinc-500">Region</dt>
              <dd className="text-zinc-100">{accessKey.sesRegion}</dd>
              <dt className="text-zinc-500">Mode</dt>
              <dd className="text-zinc-100">
                {accessKey.sendMode === "smtp" ? "SMTP" : accessKey.sendMode === "both" ? "API + SMTP" : "SES API"}
              </dd>
              {accessKey.sesConfigurationSet && (
                <>
                  <dt className="text-zinc-500">Config set</dt>
                  <dd className="break-all text-zinc-100">{accessKey.sesConfigurationSet}</dd>
                </>
              )}
            </dl>

            {accessKey.sendMode !== "api" && accessKey.sesSmtpPassword ? (
              <MailboxDetails
                label="Amazon SES SMTP credentials"
                mailbox={`SES ${accessKey.sesRegion}`}
                host={sesSmtpHost(accessKey.sesRegion || "")}
                port={accessKey.sesSmtpPort || 587}
                username={accessKey.sesSmtpUsername || accessKey.sesAccessKeyId}
                password={accessKey.sesSmtpPassword}
              />
            ) : (
              <p className="mt-4 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
                This key sends through the Amazon SES API. EVM Sentinel manages the API calls with the stored
                credentials; no SMTP password is attached. Ask your administrator for SMTP mode if you need to send
                from a mail client.
              </p>
            )}

            <div className="mt-5 space-y-2 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
              <p>
                Send from any address on <span className="text-cyan-300">@{accessKey.domain}</span> — the domain (or
                the from-address) must be verified in Amazon SES.
              </p>
              <p>
                SES may keep new accounts in the sandbox; verify recipient addresses there until production access is
                granted.
              </p>
            </div>
          </Card>
        )
      ) : isCloudflare ? (
        <Card>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-zinc-500">Provider</dt>
            <dd className="text-zinc-100">Cloudflare Email Service</dd>
            <dt className="text-zinc-500">Outbound</dt>
            <dd className="text-zinc-100">REST API — no SMTP mailbox</dd>
            <dt className="text-zinc-500">Sending domain</dt>
            <dd className="break-all text-zinc-100">@{accessKey.domain}</dd>
            {accessKey.inboxAddress && (
              <>
                <dt className="text-zinc-500">Receives at</dt>
                <dd className="break-all text-zinc-100">{accessKey.inboxAddress}</dd>
                <dt className="text-zinc-500">Forwards to</dt>
                <dd className="break-all text-zinc-100">{accessKey.inboundForwardTo || "—"}</dd>
                <dt className="text-zinc-500">Routing</dt>
                <dd className="text-zinc-100">{accessKey.emailRoutingStatus || "pending"}</dd>
              </>
            )}
          </dl>
          <div className="mt-5 space-y-2 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
            <p>
              EVM Sentinel sends your campaigns through Cloudflare&apos;s REST API. There is no SMTP username or
              password to configure, and no mailbox to host.
            </p>
            {accessKey.inboxAddress ? (
              <p>
                Mail sent to <span className="text-cyan-300">{accessKey.inboxAddress}</span> is received by Cloudflare
                and forwarded to <span className="text-cyan-300">{accessKey.inboundForwardTo}</span>. That forwarding
                inbox is the real mailbox — replies still arrive there.
              </p>
            ) : (
              <p>This key is outbound-only. Ask your administrator if you also need an address that receives mail.</p>
            )}
            <p>
              Need to send from a mail client? This key has no SMTP credentials; ask your administrator for an SMTP
              provider instead.
            </p>
          </div>
        </Card>
      ) : !hasMailbox ? (
        <EmptyState
          title="No SMTP mailbox attached"
          body={
            accessKey.provider === "devner"
              ? "Your account sends through the hosted Devner relay, so there is no SMTP mailbox to configure."
              : accessKey.provider === "elasticemail"
                ? "Your account sends through the Elastic Email HTTP API, so there is no SMTP mailbox to configure."
                : accessKey.provider === "resend"
                  ? "Your account sends through the Resend HTTP API, so there is no SMTP mailbox to configure."
                  : accessKey.provider === "mailgun"
                    ? "Your account sends through the Mailgun HTTP API, so there is no SMTP mailbox to configure."
                    : accessKey.provider === "smtp" || accessKey.provider === "custom"
                      ? "Your account uses custom SMTP. Ask your administrator to configure SMTP credentials."
                      : "Your account uses the hosted Postal API instead. Ask your administrator to attach a mailbox if you need to send with your own mail client."
          }
        />
      ) : (
        <Card>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-zinc-500">Mailbox</dt>
            <dd className="break-all text-zinc-100">{accessKey.smtpMailbox}</dd>
            <dt className="text-zinc-500">Server</dt>
            <dd className="text-zinc-100">{accessKey.smtpHost}</dd>
            <dt className="text-zinc-500">Port</dt>
            <dd className="text-zinc-100">{accessKey.smtpPort} — STARTTLS (submission)</dd>
            <dt className="text-zinc-500">Username</dt>
            <dd className="break-all text-zinc-100">{accessKey.smtpUsername}</dd>
            <dt className="text-zinc-500">Password</dt>
            <dd className="text-zinc-100">Provided by your administrator</dd>
          </dl>

          <div className="mt-5 space-y-2 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
            <p>Authenticate with TLS on port {accessKey.smtpPort}. Send from any address on{" "}
              <span className="text-cyan-300">@{accessKey.domain}</span> — the mailbox only authorises sending, it does not restrict the from-address.</p>
            <p>Mailbox credentials authenticate on the password alone; the username above is there because your mail client requires one.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
