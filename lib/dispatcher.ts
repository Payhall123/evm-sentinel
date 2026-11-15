import "server-only";

import { prisma } from "@/lib/db";
import { appBaseUrl, sendMessage } from "@/lib/postal";
import { sendViaDevner } from "@/lib/devner";
import { sendViaSesApi, deriveSesSmtpPassword, sesSmtpHost } from "@/lib/ses";
import { sendViaElasticEmail } from "@/lib/elasticemail";
import { sendViaResend } from "@/lib/resend";
import { sendViaBird } from "@/lib/bird";
import { cloudflareCredentials, sendViaCloudflare } from "@/lib/cloudflare";
import { ensureMailgunWebhooks, sendViaMailgun } from "@/lib/mailgun";
import { sendViaSmtp, type SmtpAccount } from "@/lib/smtp";
import { nextSmtpEndpoint, penaliseSmtpEndpoint, rewardSmtpEndpoint } from "@/lib/rotation";
import { buildUnsubscribeUrl, normalizeEmail, suppressedEmails } from "@/lib/unsubscribe";
import { providerFor } from "@/lib/delivery";
import { ensureWebhookForAccessKey } from "@/lib/webhooks";

// Configuration from environment variables with sensible defaults. Vercel
// functions have a hard response deadline, so serverless runs use smaller
// batches by default and stop between messages when the time budget is spent.
const IS_VERCEL = Boolean(process.env.VERCEL);
const BATCH_SIZE = Number(process.env.DISPATCH_BATCH_SIZE || (IS_VERCEL ? 25 : 50));
const POLL_MS = Number(process.env.DISPATCH_POLL_MS || 600);
const MAX_CAMPAIGNS_PER_TICK = Number(
  process.env.DISPATCH_MAX_CAMPAIGNS_PER_TICK || (IS_VERCEL ? 1 : 2),
);
const TIME_BUDGET_MS = Number(
  process.env.DISPATCH_TIME_BUDGET_MS || (IS_VERCEL ? 45_000 : 0),
);

type GlobalWorker = { timer: NodeJS.Timeout | null; running: boolean };

const g = globalThis as unknown as { evmsDispatcher?: GlobalWorker };

function getWorker(): GlobalWorker {
  return (g.evmsDispatcher ??= { timer: null, running: false });
}

export type DispatchTickResult = {
  campaigns: number;
  sent: number;
  failed: number;
  remaining: number;
  skipped: boolean;
};

const EMPTY_TICK: DispatchTickResult = {
  campaigns: 0,
  sent: 0,
  failed: 0,
  remaining: 0,
  skipped: false,
};

// Kept for local development and long-running hosts. On Vercel there is no
// durable process to hold an interval; /api/cron/dispatch calls
// runDispatcherTick() from a scheduled function instead.
export function ensureDispatcherRunning(): void {
  if (typeof window !== "undefined") return;
  if (process.env.VERCEL) return;
  const w = getWorker();
  if (w.timer) return;
  w.timer = setInterval(() => void runDispatcherTick(), POLL_MS);
  if (w.timer.unref) w.timer.unref();
  // Log when dispatcher starts (only in development to avoid excessive logging)
  if (process.env.NODE_ENV !== "production") {
    console.info("[dispatcher] started");
  }
  void runDispatcherTick();
}

type DispatchOptions = {
  batchSize?: number;
  maxCampaigns?: number;
  timeBudgetMs?: number;
};

// Runs at most `maxCampaigns` batches, and stops between messages once the time
// budget is exhausted. A stopped campaign stays "sending" with queued messages,
// so the next cron invocation resumes exactly where this one left off.
export async function runDispatcherTick(
  options: DispatchOptions = {},
): Promise<DispatchTickResult> {
  const w = getWorker();
  if (w.running) return { ...EMPTY_TICK, skipped: true };
  w.running = true;
  const tickStart = Date.now();
  const budget = options.timeBudgetMs ?? TIME_BUDGET_MS;
  const deadline = budget > 0 ? tickStart + budget : Number.POSITIVE_INFINITY;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const maxCampaigns = Math.max(1, options.maxCampaigns ?? MAX_CAMPAIGNS_PER_TICK);
  let campaignsSeen = 0;
  let sentTotal = 0;
  let failedTotal = 0;

  try {
    // Grab up to maxCampaigns distinct campaigns, oldest first, and push one
    // batch from each. Selecting the set up-front (instead of calling findFirst
    // in a loop) is what lets a single large campaign keep advancing tick after
    // tick. The previous "lastCampaignId" guard re-selected the same row every
    // tick and then skipped it forever, so a campaign would stall after exactly
    // one batch (BATCH_SIZE).
    const campaigns = await prisma.campaign.findMany({
      where: { status: { in: ["queued", "sending"] }, finishedAt: null },
      orderBy: { createdAt: "asc" },
      take: maxCampaigns,
      select: { id: true },
    });
    for (const { id } of campaigns) {
      if (Date.now() >= deadline) break;
      const outcome = await dispatchCampaign(id, batchSize, deadline);
      sentTotal += outcome.sent;
      failedTotal += outcome.failed;
      campaignsSeen++;
    }
    return {
      campaigns: campaignsSeen,
      sent: sentTotal,
      failed: failedTotal,
      remaining: Math.max(0, campaigns.length - campaignsSeen),
      skipped: false,
    };
  } catch (e) {
    // Log error but don't let it stop future ticks.
    console.error("[dispatcher] tick error", e);
    return {
      campaigns: campaignsSeen,
      sent: sentTotal,
      failed: failedTotal,
      remaining: 0,
      skipped: false,
    };
  } finally {
    w.running = false;
    const tickDuration = Date.now() - tickStart;
    // Log tick duration in development or if it took unusually long
    if (process.env.NODE_ENV !== "production" || tickDuration > 5000) {
      console.info(`[dispatcher] tick completed in ${tickDuration}ms`);
    }
  }
}

type DispatchOutcome = { sent: number; failed: number; stoppedEarly: boolean };

function noSend(): DispatchOutcome {
  return { sent: 0, failed: 0, stoppedEarly: false };
}

async function dispatchCampaign(
  campaignId: string,
  batchSize: number,
  deadline: number,
): Promise<DispatchOutcome> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      accessKey: true,
      letter: true,
    },
  });
  if (!campaign) {
    console.warn(`[dispatcher] campaign not found: ${campaignId}`);
    return noSend();
  }
  if (campaign.status === "queued") {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "sending", startedAt: new Date() },
    });
  }
  const accessKey = campaign.accessKey;
  const isDevner = accessKey.provider === "devner";
  const isSes = accessKey.provider === "ses";
  const isElasticEmail = accessKey.provider === "elasticemail";
  const isResend = accessKey.provider === "resend";
  const isBird = accessKey.provider === "bird";
  const isCloudflare = accessKey.provider === "cloudflare";
  const isMailgun = accessKey.provider === "mailgun";
  // Cloudflare Email Service sends over HTTP; per-key credentials fall back to
  // the environment so one Cloudflare account can back several keys.
  const cloudflare = cloudflareCredentials(accessKey);
  // ZeptoMail (Zoho CPaaS) submits through the same SMTP transport as a custom
  // SMTP key, using its fixed relay and single Mail Agent credential.
  const isCustomSmtp =
    accessKey.provider === "smtp" ||
    accessKey.provider === "custom" ||
    accessKey.provider === "zeptomail";
  // A Postal key is backed either by an HTTP API credential ("api"/"both") or
  // by an attached SMTP mailbox ("smtp"). SMTP-only keys never get a
  // postalApiKey, so fall back to the mailbox credentials the key was
  // provisioned with instead of failing on the missing API key.
  // Custom SMTP keys rotate across their SmtpEndpoint rows so the sends
  // spread over every server the admin attached to the key.
  const usePostalSmtp =
    !isDevner &&
    !isSes &&
    !isElasticEmail &&
    !isResend &&
    !isBird &&
    !isCloudflare &&
    !isMailgun &&
    !isCustomSmtp &&
    (accessKey.sendMode === "smtp" || (!accessKey.postalApiKey && Boolean(accessKey.smtpPassword)));
  // Endpoints in a recent circuit-breaker cooldown (disabledAt) sit out until
  // they cool down; the dispatcher sets that when an endpoint fails 3x in a row.
  const cooldownCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const smtpEndpoints = isCustomSmtp
    ? await prisma.smtpEndpoint.findMany({
        where: {
          accessKeyId: accessKey.id,
          active: true,
          OR: [{ disabledAt: null }, { disabledAt: { lt: cooldownCutoff } }],
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const smtpAccount: SmtpAccount | null = isCustomSmtp
    ? // Legacy single-server custom SMTP keys (no endpoints stored) still send.
      smtpEndpoints.length
      ? null
      : accessKey.smtpHost && accessKey.smtpPassword
        ? {
            host: accessKey.smtpHost,
            port: accessKey.smtpPort || 587,
            username: accessKey.smtpUsername || accessKey.smtpMailbox || "",
            password: accessKey.smtpPassword,
          }
        : null
    : usePostalSmtp
    ? {
        host: accessKey.smtpHost || "",
        port: accessKey.smtpPort || 587,
        username: accessKey.smtpUsername || accessKey.smtpMailbox || "",
        password: accessKey.smtpPassword || "",
      }
    : null;
  // Amazon SES can carry the same campaign through its API or its SMTP
  // endpoint. "both" sends through the API while exposing SMTP credentials to
  // the customer, so only an explicit SMTP mode (or a key with no API
  // credentials) uses the SMTP endpoint here.
  const useSesSmtp =
    isSes &&
    (accessKey.sendMode === "smtp" ||
      (!accessKey.sesAccessKeyId && Boolean(accessKey.sesSmtpPassword)));
  const sesSmtpAccount: SmtpAccount | null = useSesSmtp
    ? {
        host: accessKey.sesRegion ? sesSmtpHost(accessKey.sesRegion) : "",
        port: accessKey.sesSmtpPort || 587,
        username: accessKey.sesSmtpUsername || accessKey.sesAccessKeyId || "",
        password:
          accessKey.sesSmtpPassword ||
          (accessKey.sesRegion && accessKey.sesSecretAccessKey
            ? deriveSesSmtpPassword(accessKey.sesSecretAccessKey, accessKey.sesRegion)
            : ""),
      }
    : null;
  const sendKey = isDevner
    ? accessKey.devnerApiKey || process.env.DEVNER_API_KEY || ""
    : isSes
      ? ""
      : isElasticEmail
        ? accessKey.elasticEmailApiKey || process.env.ELASTICEMAIL_API_KEY || ""
                  : isResend
          ? accessKey.resendApiKey || process.env.RESEND_API_KEY || ""
          : isBird
            ? accessKey.birdApiKey || process.env.BIRD_API_KEY || ""
          : isCloudflare
            ? ""
            : isMailgun
              ? accessKey.mailgunApiKey || process.env.MAILGUN_API_KEY || ""
              : isCustomSmtp
                ? ""
                : accessKey.postalApiKey || "";
  // Record which transport actually carries this campaign so the delivery
  // analytics can label the source and match provider callbacks.
  const provider = providerFor(accessKey);
  const transportReady = isDevner
    ? Boolean(sendKey)
    : isSes
      ? sesSmtpAccount
        ? Boolean(sesSmtpAccount.host && sesSmtpAccount.password)
        : Boolean(accessKey.sesRegion && accessKey.sesAccessKeyId && accessKey.sesSecretAccessKey)
      : isElasticEmail
        ? Boolean(sendKey)
        : isResend
          ? Boolean(sendKey)
          : isBird
            ? Boolean(sendKey)
          : isCloudflare
            ? Boolean(cloudflare.accountId && cloudflare.apiToken)
            : isMailgun
              ? Boolean(sendKey && accessKey.domain)
              : isCustomSmtp
                ? Boolean(smtpEndpoints.length) || Boolean(smtpAccount?.host && smtpAccount?.password)
                : smtpAccount
                  ? Boolean(smtpAccount.host && smtpAccount.password)
                  : Boolean(sendKey);
  if (accessKey.status === "revoked" || !transportReady) {
    const reason =
      accessKey.status === "revoked"
        ? "Access key revoked"
        : isDevner
          ? "Missing Devner API key"
          : isSes
            ? useSesSmtp
              ? "Missing Amazon SES SMTP credentials"
              : "Missing Amazon SES API credentials"
            : isElasticEmail
              ? "Missing Elastic Email API key"
              : isResend
                ? "Missing Resend API key"
                : isBird
                  ? "Missing Bird API key"
                : isCloudflare
                  ? "Missing Cloudflare account ID or API token"
                  : isMailgun
                    ? "Missing Mailgun API key or sending domain"
                    : isCustomSmtp
                      ? "No active SMTP servers attached"
                      : smtpAccount
                        ? "Missing SMTP mailbox credentials"
                        : "Missing Postal API key";
    console.warn(`[dispatcher] campaign ${campaignId} failed: ${reason}`);
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "failed", error: reason, finishedAt: new Date() },
    });
    await prisma.message.updateMany({
      where: { campaignId, status: "queued" },
      data: { status: "failed", error: reason, sentAt: new Date() },
    });
    return noSend();
  }

  const now = new Date();
  if (accessKey.expiresAt && now.getTime() > accessKey.expiresAt.getTime()) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "failed", error: "Access key expired", finishedAt: new Date() },
    });
    await prisma.message.updateMany({
      where: { campaignId, status: "queued" },
      data: { status: "failed", error: "Access key expired", sentAt: new Date() },
    });
    return noSend();
  }

  let dailyLimitReached = false;
  if (accessKey.dailyLimit != null && Number.isInteger(accessKey.dailyLimit) && accessKey.dailyLimit >= 0) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const sentToday = await prisma.message.count({
      where: {
        campaign: { accessKeyId: accessKey.id },
        status: "sent",
        sentAt: { gte: dayStart },
      },
    });
    if (sentToday >= accessKey.dailyLimit) dailyLimitReached = true;
  }

  if (dailyLimitReached) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "failed", error: "Daily send limit reached", finishedAt: new Date() },
    });
    await prisma.message.updateMany({
      where: { campaignId, status: "queued" },
      data: { status: "failed", error: "Daily send limit reached", sentAt: new Date() },
    });
    return noSend();
  }

  const batch = await prisma.message.findMany({
    where: { campaignId, status: "queued" },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    include: { contact: true },
  });
  if (!batch.length) {
    await triggerFinishCheck(campaignId);
    return noSend();
  }

  // Ensure Postal will report delivery outcomes for this key's mail server.
  // Runs once per key (returns immediately thereafter); a failure here must
  // never stop mail from going out.
  if (provider.startsWith("postal") && !accessKey.postalWebhookSecret) {
    try {
      await ensureWebhookForAccessKey(accessKey.id);
    } catch (e) {
      console.error("[dispatcher] delivery webhook registration failed", e);
    }
  }

  // Register Mailgun's delivery-event webhook on first use. Like the Postal
  // registration above, a failure here must never stop mail from going out;
  // the next campaign will retry.
  if (isMailgun && !accessKey.mailgunWebhookAt && accessKey.mailgunWebhookSecret) {
    const base = appBaseUrl();
    if (!base) {
      console.warn(
        "[dispatcher] Mailgun delivery webhook not registered: APP_BASE_URL / UNSUBSCRIBE_BASE_URL is unset",
      );
    } else {
      try {
        const webhookUrl = `${base}/api/webhooks/mailgun?k=${encodeURIComponent(accessKey.mailgunWebhookSecret)}`;
        await ensureMailgunWebhooks(
          {
            apiKey: sendKey,
            domain: accessKey.domain,
            apiBase: accessKey.mailgunApiBase,
          },
          webhookUrl,
        );
        await prisma.accessKey.update({
          where: { id: accessKey.id },
          data: { mailgunWebhookAt: new Date() },
        });
        console.info(`[dispatcher] Mailgun delivery webhook registered for access key ${accessKey.id}`);
      } catch (e) {
        console.error("[dispatcher] Mailgun delivery webhook registration failed", e);
      }
    }
  }

  const sent: string[] = [];
  const failed: string[] = [];
  let error: string | null = null;
  let stoppedEarly = false;
  // One lookup per batch rather than per message. Suppressions outlive the
  // contact rows they came from, so an opt-out still holds after the list is
  // re-imported; unsubscribedAt additionally covers contacts that opted out
  // before the Suppression table existed.
  const suppressed = await suppressedEmails(accessKey.id);
  for (const m of batch) {
    // Leave the rest queued for the next cron invocation instead of letting
    // Vercel kill the function mid-send.
    if (Date.now() >= deadline) {
      stoppedEarly = true;
      break;
    }
    if (suppressed.has(normalizeEmail(m.email)) || m.contact?.unsubscribedAt) {
      await prisma.message.update({
        where: { id: m.id },
        data: { status: "skipped", error: "recipient unsubscribed", sentAt: new Date() },
      });
      continue;
    }

    const values = fillValues(m.contact, m.email);
    // Signed per recipient, so a one-click unsubscribe is attributable to a
    // single mailbox. Empty when UNSUBSCRIBE_SECRET/BASE_URL are unset, in
    // which case the message goes out without the header rather than with a
    // link that 404s.
    const unsubscribeUrl = buildUnsubscribeUrl(accessKey.id, m.contactId);
    const unsubscribeHeaders = unsubscribeUrl
      ? {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : undefined;
    try {
      const params = {
        to: [m.email],
        replyTo: campaign.replyTo,
        subject: interpolate(campaign.subject, values),
        html: campaign.letter.htmlBody ? interpolate(campaign.letter.htmlBody, values) : null,
        text: campaign.letter.plainText ? interpolate(campaign.letter.plainText, values) : null,
      };
      // Devner owns the sender address and rotates its own connected mailboxes,
      // so no `from` is sent; Postal (API or SMTP), SES, Elastic Email, Resend,
      // Cloudflare and Mailgun all need an explicit one.
      const result = isDevner
        ? await sendViaDevner(sendKey, { ...params, unsubscribeUrl: unsubscribeUrl || undefined })
        : isSes
          ? sesSmtpAccount
            ? await sendViaSmtp(sesSmtpAccount, {
                ...params,
                from: campaign.fromEmail,
                fromName: campaign.fromName,
                headers: unsubscribeHeaders,
              })
            : await sendViaSesApi(
                {
                  region: accessKey.sesRegion || "",
                  accessKeyId: accessKey.sesAccessKeyId || "",
                  secretAccessKey: accessKey.sesSecretAccessKey || "",
                  configurationSetName: accessKey.sesConfigurationSet,
                },
                {
                  ...params,
                  from: campaign.fromEmail,
                  fromName: campaign.fromName,
                  headers: unsubscribeHeaders,
                },
              )
          : isElasticEmail
            ? await sendViaElasticEmail(sendKey, {
                ...params,
                from: campaign.fromEmail,
                fromName: campaign.fromName,
                headers: unsubscribeHeaders,
              })
            : isResend
              ? await sendViaResend(sendKey, {
                  ...params,
                  from: campaign.fromEmail,
                  fromName: campaign.fromName,
                  headers: unsubscribeHeaders,
                })
              : isBird
                ? await sendViaBird(sendKey, {
                    ...params,
                    from: campaign.fromEmail,
                    fromName: campaign.fromName,
                    headers: unsubscribeHeaders,
                  })
              : isCloudflare
                ? await sendViaCloudflare(cloudflare, {
                    ...params,
                    from: campaign.fromEmail,
                    fromName: campaign.fromName,
                    headers: unsubscribeHeaders,
                  })
              : isMailgun
                ? await sendViaMailgun(
                    {
                      apiKey: sendKey,
                      domain: accessKey.domain,
                      apiBase: accessKey.mailgunApiBase,
                    },
                    {
                      ...params,
                      from: campaign.fromEmail,
                      fromName: campaign.fromName,
                      headers: unsubscribeHeaders,
                    },
                  )
                : smtpAccount
                ? await sendViaSmtp(smtpAccount!, {
                    ...params,
                    from: campaign.fromEmail,
                    fromName: campaign.fromName,
                    headers: unsubscribeHeaders,
                  })
                : isCustomSmtp && smtpEndpoints.length
                  // Custom SMTP with several servers: rotate across them.
                  // (Legacy single-server keys use the smtpAccount branch above.)
                  ? (await sendViaRotatingSmtp(accessKey.id, smtpEndpoints, {
                      ...params,
                      from: campaign.fromEmail,
                      fromName: campaign.fromName,
                      headers: unsubscribeHeaders,
                    })).result
                : await sendMessage(sendKey, {
                    ...params,
                    from: campaign.fromEmail,
                    fromName: campaign.fromName,
                    headers: unsubscribeHeaders,
                  });
      const postalToken = result.perRecipient[m.email];
      const correlationId = result.perRecipientRef?.[m.email] || null;
      sent.push(m.id);
      await prisma.message.update({
        where: { id: m.id },
        data: {
          status: "sent",
          postalId: postalToken || null,
          correlationId,
          provider,
          sentAt: new Date(),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown transport error";
      error = msg;
      failed.push(m.id);
      await prisma.message.update({
        where: { id: m.id },
        data: { status: "failed", error: msg, provider, sentAt: new Date() },
      });
    }
  }

  await prisma.$transaction([
    prisma.campaign.update({
      where: { id: campaignId },
      data: { sentCount: { increment: sent.length }, failedCount: { increment: failed.length }, error: error ?? null },
    }),
  ]);

  await triggerFinishCheck(campaignId);
  return { sent: sent.length, failed: failed.length, stoppedEarly };
}

// Sends one message through the key's SMTP servers in round-robin order. On a
// transport error the endpoint is penalised (set aside for a cooldown) and the
// send is retried once on the next server, so a flaky or throttling provider
// does not hold up the batch. Consecutive failures are recorded on the
// SmtpEndpoint row so admins can see which server misbehaves.
type RotationEndpoint = { id: string; host: string; port: number; username: string; password: string; failCount: number; label?: string | null };
type SmtpSend = Awaited<ReturnType<typeof sendViaSmtp>>;
type SmtpParams = Parameters<typeof sendViaSmtp>[1];

async function sendViaRotatingSmtp(
  accessKeyId: string,
  endpoints: RotationEndpoint[],
  params: SmtpParams,
): Promise<{ result: SmtpSend; endpointId: string; endpointHost: string }> {
  let lastError: unknown = null;
  const tried = new Set<string>();
  for (let attempt = 0; attempt < Math.min(2, endpoints.length); attempt++) {
    const remaining = endpoints.filter((e) => !tried.has(e.id));
    const endpoint = nextSmtpEndpoint(accessKeyId, remaining);
    if (!endpoint) break;
    tried.add(endpoint.id);
    try {
      const result = await sendViaSmtp(
        { host: endpoint.host, port: endpoint.port, username: endpoint.username, password: endpoint.password },
        params,
      );
      rewardSmtpEndpoint(accessKeyId, endpoint.id);
      if (endpoint.failCount > 0) {
        void prisma.smtpEndpoint
          .update({ where: { id: endpoint.id }, data: { failCount: 0, disabledAt: null } })
          .catch(() => undefined);
      }
      return { result, endpointId: endpoint.id, endpointHost: endpoint.host };
    } catch (e) {
      lastError = e;
      const repeated = endpoint.failCount >= 2;
      const newCount = endpoint.failCount + 1;
      penaliseSmtpEndpoint(accessKeyId, endpoint.id, repeated);
      void prisma.smtpEndpoint
        .update({
          where: { id: endpoint.id },
          data: {
            failCount: { increment: 1 },
            // Trip the durable circuit breaker every 3rd consecutive failure so
            // the endpoint skips future batches until it cools down.
            ...(newCount % 3 === 0 ? { disabledAt: new Date() } : {}),
          },
        })
        .catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All SMTP servers failed");
}

function fillValues(contact: { firstName?: string | null; lastName?: string | null } | null, email: string): Record<string, string> {  return {
    email,
    firstName: contact?.firstName || "",
    lastName: contact?.lastName || "",
  };
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(firstName|lastName|email)\}/g, (_match, key: string) => values[key] ?? "");
}

async function triggerFinishCheck(campaignId: string): Promise<void> {
  const [queued, sent, failed, skipped] = await Promise.all([
    prisma.message.count({ where: { campaignId, status: "queued" } }),
    prisma.message.count({ where: { campaignId, status: "sent" } }),
    prisma.message.count({ where: { campaignId, status: "failed" } }),
    prisma.message.count({ where: { campaignId, status: "skipped" } }),
  ]);
  if (queued !== 0) return;
  // Suppressed recipients are a normal outcome, not a failure, so they count
  // towards completion and never mark an otherwise clean campaign "partial".
  const delivered = sent + skipped;
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: delivered === 0 ? "failed" : failed > 0 ? "partial" : "sent",
      finishedAt: new Date(),
    },
  });
}