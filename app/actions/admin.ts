"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import {
  provisionDomain,
  verifyDomain,
  listMailboxes,
  createMailbox,
  attachMailbox,
  type DomainDnsInfo,
  type MailboxCredential,
} from "@/lib/postal";
import {
  deriveSesSmtpPassword,
  sesSmtpHost,
  SES_SMTP_DEFAULT_PORT,
} from "@/lib/ses";
import {
  cloudflareCredentials,
  provisionCloudflareRouting,
  type RoutingDnsRecord,
} from "@/lib/cloudflare";
import { accessKeyCreateSchema, accessKeyGovernanceSchema, smtpEndpointsSchema, smtpEndpointSchema } from "@/lib/validation";
import { resetSmtpRotation } from "@/lib/rotation";

// ZeptoMail (now Zoho CPaaS) submits over a standard SMTP relay. The host and
// port are fixed by the service; only the Mail Agent's SMTP username/password
// vary per account. Environment overrides are optional and mainly useful when
// an operator wants to create ZeptoMail keys without re-entering the relay.
const ZEPTOMAIL_SMTP_HOST = process.env.ZEPTOMAIL_SMTP_HOST?.trim() || "smtp.zeptomail.com";
const ZEPTOMAIL_SMTP_PORT = (() => {
  const port = Number(process.env.ZEPTOMAIL_SMTP_PORT || 587);
  return Number.isInteger(port) ? port : 587;
})();

export type AccessKeyFormState = {
  error?: string;
  key?: string;
  ok?: boolean;
  mode?: string;
  provider?: string;
  mailbox?: { name: string; username: string; password: string; host: string; port: number } | null;
  ses?: {
    region: string;
    host: string;
    port: number;
    username: string;
    password: string;
    configurationSet?: string | null;
  } | null;
  smtp?: {
    host: string;
    port: number;
    username: string;
    password: string;
  } | null;
  // How many SMTP servers were attached to a custom-SMTP key.
  smtpCount?: number;
  // Cloudflare Email Service result: the REST send transport plus, when the
  // admin asked for inbound mail, the Email Routing rule + DNS records.
  cloudflare?: {
    accountId: string;
    domain: string;
    inboxAddress?: string | null;
    forwardTo?: string | null;
    zoneId?: string | null;
    status?: string | null;
    ruleId?: string | null;
    records: RoutingDnsRecord[];
    note?: string | null;
    error?: string | null;
  } | null;
};

function randomKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `evm_${out}`;
}

// Cloudflare routing rules match a full address. Admins may type either
// "hello@acme.com" or just "hello"; a local part is completed with the key's
// sending domain. Returns null for an empty value so callers can tell "not
// requested" apart from "invalid".
function normalizeInboxAddress(value: string | null | undefined, domain: string): string | null {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return null;
  return raw.includes("@") ? raw : `${raw}@${domain}`;
}

// A mailbox reference is "org|server" (a mail server) or "org|server|uuid" (a
// specific SMTP credential). Both come from listMailboxes().
function splitRef(ref: string | undefined): { org: string; server: string; id: string } | null {
  if (!ref) return null;
  const [org, server, id = ""] = ref.split("|");
  if (!org || !server) return null;
  return { org, server, id };
}

// Resolves the SMTP mailbox to attach: an existing credential, or a new one
// created on an existing server / on the server provisioned in this request.
async function resolveMailbox(opts: {
  sendMode: string;
  source: string | undefined;
  ref?: string;
  target?: string;
  name?: string;
  username?: string;
  provisioned?: { orgPermalink: string; serverPermalink: string } | null;
}): Promise<MailboxCredential> {
  const username = opts.username || undefined;

  if (opts.source !== "new") {
    const { org, server, id } = splitRef(opts.ref) || { org: "", server: "", id: "" };
    if (!id) throw new Error("Choose a mailbox to attach.");
    const { mailboxes } = await listMailboxes();
    const match = mailboxes.find((m) => m.orgPermalink === org && m.serverPermalink === server && m.id === id);
    if (!match) throw new Error("The selected mailbox could not be found in Postal.");
    return attachMailbox(match, username);
  }

  const name = (opts.name || "").trim();
  if (!name) throw new Error("Give the new mailbox a name.");
  const target =
    opts.sendMode === "both" && opts.provisioned
      ? `${opts.provisioned.orgPermalink}|${opts.provisioned.serverPermalink}`
      : opts.target;
  const { org, server } = splitRef(target) || { org: "", server: "" };
  if (!org || !server) throw new Error("Choose a Postal server to create the mailbox on.");
  return createMailbox(org, server, name, username);
}

export async function createAccessKeyAction(_prev: AccessKeyFormState | undefined, formData: FormData): Promise<AccessKeyFormState> {
  await requireAdmin();
  const parsed = accessKeyCreateSchema.safeParse({
    name: formData.get("name"),
    domain: formData.get("domain"),
    provider: formData.get("provider") || "postal",
    devnerApiKey: formData.get("devnerApiKey"),
    elasticEmailApiKey: formData.get("elasticEmailApiKey"),
    resendApiKey: formData.get("resendApiKey"),
    birdApiKey: formData.get("birdApiKey"),
    mailgunApiKey: formData.get("mailgunApiKey"),
    mailgunApiBase: formData.get("mailgunApiBase"),
    sesRegion: formData.get("sesRegion"),
    sesAccessKeyId: formData.get("sesAccessKeyId"),
    sesSecretAccessKey: formData.get("sesSecretAccessKey"),
    sesSmtpUsername: formData.get("sesSmtpUsername"),
    sesSmtpPassword: formData.get("sesSmtpPassword"),
    sesSmtpPort: formData.get("sesSmtpPort"),
    sesConfigurationSet: formData.get("sesConfigurationSet"),
    sendMode: formData.get("sendMode") || "api",
    mailboxSource: formData.get("mailboxSource") || undefined,
    mailboxRef: formData.get("mailboxRef") || undefined,
    mailboxTarget: formData.get("mailboxTarget") || undefined,
    mailboxName: formData.get("mailboxName") || undefined,
    mailboxUsername: formData.get("mailboxUsername") || undefined,
    dailyLimit: formData.get("dailyLimit"),
    expiresAt: formData.get("expiresAt"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid input" };

  const {
    name,
    sendMode,
    mailboxSource,
    provider,
    devnerApiKey,
    elasticEmailApiKey,
    resendApiKey,
    birdApiKey,
    mailgunApiKey,
    mailgunApiBase,
  } = parsed.data;
  const email = String(formData.get("email") || "").trim().toLowerCase() || null;
  const wantsApi = sendMode !== "smtp";
  const wantsSmtp = sendMode !== "api";

  // Amazon SES: the customer's AWS credentials carry the mail, so there is no
  // Postal provisioning step and the key is usable immediately. The API path
  // needs the IAM access key + secret; SMTP-only setups may instead supply the
  // SES SMTP password directly. When no SMTP password is supplied we derive it
  // from the secret using AWS' documented conversion.
  if (provider === "ses") {
    const domain = parsed.data.domain;
    if (!domain) {
      return { error: "A sending domain is required for an Amazon SES key (it must be verified in SES)." };
    }

    const region = (parsed.data.sesRegion || "").toLowerCase();
    if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) {
      return { error: "Enter a valid AWS region, e.g. us-east-1." };
    }

    const accessKeyId = parsed.data.sesAccessKeyId || "";
    const secretAccessKey = parsed.data.sesSecretAccessKey || "";
    if (!accessKeyId) {
      return { error: "An AWS access key ID is required for Amazon SES." };
    }
    if (sendMode !== "smtp" && !secretAccessKey) {
      return { error: "The AWS secret access key is required for SES API sending." };
    }

    const smtpPassword =
      parsed.data.sesSmtpPassword ||
      (secretAccessKey ? deriveSesSmtpPassword(secretAccessKey, region) : "");
    if (sendMode !== "api" && !smtpPassword) {
      return { error: "Provide the SES SMTP password, or the secret access key so it can be derived." };
    }

    const smtpUsername = parsed.data.sesSmtpUsername || accessKeyId;
    const smtpPort = parsed.data.sesSmtpPort ?? SES_SMTP_DEFAULT_PORT;
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain,
        provider: "ses",
        sendMode,
        status: "active",
        sesRegion: region,
        sesAccessKeyId: accessKeyId,
        sesSecretAccessKey: secretAccessKey || null,
        sesSmtpUsername: smtpUsername,
        sesSmtpPassword: smtpPassword || null,
        sesSmtpPort: smtpPort,
        sesConfigurationSet: parsed.data.sesConfigurationSet ?? null,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return {
      key,
      mode: sendMode,
      provider: "ses",
      ses: {
        region,
        host: sesSmtpHost(region),
        port: smtpPort,
        username: smtpUsername,
        password: smtpPassword,
        configurationSet: parsed.data.sesConfigurationSet ?? null,
      },
      mailbox: null,
    };
  }

  // Devner relay: no Postal resources are provisioned and the key is usable
  // immediately. The from-address must belong to a Gmail account connected to
  // the Devner account that owns devnerApiKey (or DEVNER_API_KEY).
  if (provider === "devner") {
    if (!parsed.data.domain) {
      return { error: "A sending domain is required for a Devner key (the domain of the connected Gmail account)." };
    }
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain: parsed.data.domain,
        provider: "devner",
        devnerApiKey: devnerApiKey ?? null,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
        sendMode: "api",
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return { key, mode: "devner", provider: "devner", mailbox: null };
  }

  // Elastic Email: the user's own API key authenticates every send, and the
  // sending domain must already be verified in that Elastic Email account. No
  // Postal resources are provisioned, so the key is usable immediately.
  if (provider === "elasticemail") {
    if (!parsed.data.domain) {
      return {
        error: "A sending domain is required for an Elastic Email key (it must be verified in that Elastic Email account).",
      };
    }
    if (!elasticEmailApiKey) {
      return { error: "An Elastic Email API key is required for this access key." };
    }
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain: parsed.data.domain,
        provider: "elasticemail",
        sendMode: "api",
        elasticEmailApiKey,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return { key, mode: "api", provider: "elasticemail", mailbox: null };
  }

  // Resend: the user's own API key authenticates every send and the sending
  // domain must already be verified in that Resend account. Like Elastic Email
  // no Postal resources are provisioned, so the key is usable immediately.
  if (provider === "resend") {
    if (!parsed.data.domain) {
      return {
        error: "A sending domain is required for a Resend key (it must be verified in that Resend account).",
      };
    }
    if (!resendApiKey) {
      return { error: "A Resend API key is required for this access key." };
    }
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain: parsed.data.domain,
        provider: "resend",
        sendMode: "api",
        resendApiKey,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return { key, mode: "api", provider: "resend", mailbox: null };
  }

  // Bird (MessageBird): the user's own API key authenticates every send and the
  // sending domain must already be verified in that Bird workspace. Like Resend
  // no Postal resources are provisioned, so the key is usable immediately.
  if (provider === "bird") {
    if (!parsed.data.domain) {
      return {
        error: "A sending domain is required for a Bird key (it must be verified in that Bird workspace).",
      };
    }
    if (!birdApiKey) {
      return { error: "A Bird API key is required for this access key." };
    }
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain: parsed.data.domain,
        provider: "bird",
        sendMode: "api",
        birdApiKey,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return { key, mode: "api", provider: "bird", mailbox: null };
  }

  // Cloudflare Email Service: outbound mail goes through Cloudflare's REST API
  // (no SMTP). The same account/token can optionally create an Email Routing
  // rule so the user's address receives mail and forwards it to a real inbox.
  // Inbound provisioning is best-effort: a missing routing permission must not
  // block outbound sending, so the key is still created and the error is shown
  // on the access-key card.
  if (provider === "cloudflare") {
    const domain = parsed.data.domain;
    if (!domain) {
      return {
        error:
          "A sending domain is required for Cloudflare Email Service. Onboard it under Cloudflare Email Sending first.",
      };
    }

    const credentials = cloudflareCredentials({
      cloudflareAccountId: parsed.data.cloudflareAccountId,
      cloudflareApiToken: parsed.data.cloudflareApiToken,
    });
    if (!credentials.accountId) {
      return {
        error:
          "Enter the Cloudflare account ID, or set CLOUDFLARE_ACCOUNT_ID. The same account must own the sending domain.",
      };
    }
    if (!credentials.apiToken) {
      return {
        error:
          "Enter a Cloudflare API token, or set CLOUDFLARE_API_TOKEN. It needs Email Sending: Edit; add Email Routing permissions if you want inbound mail.",
      };
    }

    const inboxAddress = normalizeInboxAddress(parsed.data.inboxAddress, domain);
    const forwardTo = (parsed.data.inboundForwardTo || "").trim().toLowerCase() || null;

    if (inboxAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inboxAddress)) {
      return { error: "Enter a valid inbox address, e.g. hello@acme.com." };
    }
    if (inboxAddress && !inboxAddress.endsWith(`@${domain}`)) {
      return { error: `The inbox address must be on the sending domain (@${domain}).` };
    }
    if (inboxAddress && !forwardTo) {
      return {
        error:
          "Add the destination inbox Cloudflare should forward to (for example the user's Gmail). Email Routing needs a verified destination.",
      };
    }
    if (forwardTo && !inboxAddress) {
      return { error: "Add the inbox address that should forward to this destination." };
    }

    const key = randomKey();
    const created = await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain,
        provider: "cloudflare",
        sendMode: "api",
        status: "active",
        cloudflareAccountId: credentials.accountId,
        cloudflareApiToken: credentials.apiToken,
        cloudflareZoneId: parsed.data.cloudflareZoneId,
        inboxAddress,
        inboundForwardTo: forwardTo,
        emailRoutingStatus: inboxAddress ? "pending" : null,
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
      },
    });

    let routing: Awaited<ReturnType<typeof provisionCloudflareRouting>> | null = null;
    let routingError: string | null = null;

    if (inboxAddress && forwardTo) {
      try {
        routing = await provisionCloudflareRouting({
          credentials,
          domain,
          zoneId: parsed.data.cloudflareZoneId,
          address: inboxAddress,
          forwardTo,
          name: `EVM Sentinel — ${name}`,
        });
        await prisma.accessKey.update({
          where: { id: created.id },
          data: {
            cloudflareZoneId: routing.zoneId,
            cloudflareRuleId: routing.ruleId,
            emailRoutingStatus: routing.status,
            emailRoutingRecords: routing.records as unknown as Prisma.InputJsonValue,
            emailRoutingNote: routing.note,
            emailRoutingError: null,
            emailRoutingCheckedAt: new Date(),
          },
        });
      } catch (e) {
        routingError = e instanceof Error ? e.message : "Cloudflare Email Routing setup failed";
        await prisma.accessKey.update({
          where: { id: created.id },
          data: {
            emailRoutingStatus: "error",
            emailRoutingError: routingError,
            emailRoutingCheckedAt: new Date(),
          },
        });
      }
    }

    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return {
      key,
      mode: "api",
      provider: "cloudflare",
      mailbox: null,
      cloudflare: {
        accountId: credentials.accountId,
        domain,
        inboxAddress,
        forwardTo,
        zoneId: routing?.zoneId ?? parsed.data.cloudflareZoneId ?? null,
        status: routing?.status ?? (inboxAddress ? "error" : null),
        ruleId: routing?.ruleId ?? null,
        records: routing?.records ?? [],
        note: routing?.note ?? null,
        error: routingError,
      },
    };
  }

  // Mailgun: the API key authenticates every send against the Mailgun domain
  // stored as this key's sending domain. Sandbox domains work, but Mailgun only
  // delivers them to authorised recipients until the domain is upgraded.
  if (provider === "mailgun") {
    if (!parsed.data.domain) {
      return {
        error:
          "A sending domain is required for a Mailgun key (use the Mailgun sending domain, including a sandbox domain).",
      };
    }
    if (!mailgunApiKey) {
      return { error: "A Mailgun API key is required for this access key." };
    }
    if (mailgunApiBase && !/^https?:\/\/[^\s]+$/i.test(mailgunApiBase)) {
      return { error: "Enter a valid Mailgun API base URL (e.g. https://api.mailgun.net)." };
    }
    const key = randomKey();
    await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain: parsed.data.domain,
        provider: "mailgun",
        sendMode: "api",
        mailgunApiKey,
        mailgunApiBase,
        mailgunWebhookSecret: randomBytes(32).toString("hex"),
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
      },
    });
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return { key, mode: "api", provider: "mailgun", mailbox: null };
  }

  // Custom SMTP provider (e.g., Spacemail) and ZeptoMail (Zoho CPaaS SMTP).
  // Custom keys accept several SMTP servers per key: the create form posts them
  // as JSON in "smtpEndpoints", and the dispatcher rotates across them so no
  // single server carries the campaign. ZeptoMail uses the same transport but a
  // fixed relay (smtp.zeptomail.com) and a single Mail Agent credential pair.
  // Single-server keys keep working via the legacy flat fields.
  if (provider === "smtp" || provider === "custom" || provider === "zeptomail") {
    const isZeptomail = provider === "zeptomail";
    const domain = parsed.data.domain;
    if (!domain) {
      return {
        error: isZeptomail
          ? "A sending domain is required for a ZeptoMail key (it must be verified in ZeptoMail)."
          : "A sending domain is required for a custom SMTP key.",
      };
    }

    let endpoints: { label?: string | null; host: string; port: number; username: string; password: string }[] = [];
    if (isZeptomail) {
      // The relay host/port come from ZeptoMail; the operator only supplies the
      // Mail Agent's SMTP username and password. Env values are a fallback for
      // scripted provisioning so credentials never have to live in the form.
      const username = String(
        formData.get("zeptomailUsername") || process.env.ZEPTOMAIL_SMTP_USERNAME || "",
      ).trim();
      const password = String(
        formData.get("zeptomailPassword") || process.env.ZEPTOMAIL_SMTP_PASSWORD || "",
      ).trim();
      if (!username || !password) {
        return { error: "Enter the ZeptoMail SMTP username and password." };
      }
      endpoints = [
        {
          label: "ZeptoMail",
          host: ZEPTOMAIL_SMTP_HOST,
          port: ZEPTOMAIL_SMTP_PORT,
          username,
          password,
        },
      ];
    } else {
      // Preferred: the multi-server payload from the create form. Fallback: the
      // legacy individual fields (also keeps API callers working).
      const raw = formData.get("smtpEndpoints");
      if (raw && String(raw).trim()) {
        try {
          const check = smtpEndpointsSchema.safeParse(JSON.parse(String(raw)));
          if (!check.success) return { error: check.error.issues[0]?.message || "Invalid SMTP credentials" };
          endpoints = check.data.map((e) => ({ label: e.label ?? null, host: e.host, port: Number(e.port), username: e.username, password: e.password }));
        } catch {
          return { error: "Invalid SMTP credentials payload" };
        }
      }
      if (!endpoints.length) {
        const host = String(formData.get("smtpHost") || "").trim();
        const portRaw = String(formData.get("smtpPort") || "587").trim();
        const username = String(formData.get("smtpUsername") || "").trim();
        const password = String(formData.get("smtpPassword") || "").trim();
        if (host && username && password) {
          const port = Number(portRaw);
          if (Number.isNaN(port)) return { error: "Invalid SMTP port." };
          endpoints = [{ host, port, username, password }];
        }
      }
    }
    if (!endpoints.length) {
      return { error: "Add at least one SMTP server (host, port, username, password)." };
    }

    const storedProvider = isZeptomail ? "zeptomail" : "smtp";
    const key = randomKey();
    const [primary] = endpoints;
    const created = await prisma.accessKey.create({
      data: {
        key,
        name,
        email,
        domain,
        provider: storedProvider,
        sendMode: "smtp",
        // Mirror the first endpoint onto the legacy columns so the dashboard
        // and any code reading smtpHost keep working.
        smtpHost: primary.host,
        smtpPort: primary.port,
        smtpUsername: primary.username,
        smtpPassword: primary.password,
        smtpEndpoints: {
          create: endpoints.map((e) => ({
            label: e.label || null,
            host: e.host,
            port: e.port,
            username: e.username,
            password: e.password,
          })),
        },
        dailyLimit: parsed.data.dailyLimit ?? null,
        expiresAt: parsed.data.expiresAt ?? null,
        status: "active",
      },
    });
    // Touch the relation so the types stay honest if this line is removed later.
    void created;
    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return {
      key,
      mode: "smtp",
      provider: storedProvider,
      mailbox: null,
      smtp: {
        host: primary.host,
        port: primary.port,
        username: primary.username,
        password: primary.password,
      },
      smtpCount: endpoints.length,
    };
  }

  if (wantsApi && !parsed.data.domain) {
    return { error: "A sending domain is required when provisioning a Postal domain." };
  }

  // Resolve the mailbox before writing anything when it does not depend on the
  // server we are about to provision, so a bad pick fails fast.
  const needsProvisionalServer = wantsSmtp && mailboxSource === "new" && sendMode === "both";
  let mailbox: MailboxCredential | null = null;
  if (wantsSmtp && !needsProvisionalServer) {
    try {
      mailbox = await resolveMailbox({
        sendMode,
        source: mailboxSource,
        ref: parsed.data.mailboxRef,
        target: parsed.data.mailboxTarget,
        name: parsed.data.mailboxName,
        username: parsed.data.mailboxUsername,
        provisioned: null,
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not attach the Postal mailbox" };
    }
  }

  const domain = parsed.data.domain || mailbox?.domains[0] || null;
  if (!domain) {
    return { error: "Could not determine a sending domain. Pick a mailbox on a Postal server that has a domain." };
  }

  const key = randomKey();

  // Reserve the record first so the user can be created even if provisioning is slow
  const accessKey = await prisma.accessKey.create({
    data: {
      key,
      name,
      email,
      domain,
      dailyLimit: parsed.data.dailyLimit ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
      status: "provisioning",
      provider: "postal",
      sendMode,
    },
  });

  try {
    let provisioned: { orgPermalink: string; serverPermalink: string } | null = null;

    if (wantsApi) {
      const result = await provisionDomain(domain, name);
      provisioned = { orgPermalink: result.orgPermalink, serverPermalink: result.serverPermalink };
      await prisma.accessKey.update({
        where: { id: accessKey.id },
        data: {
          postalOrg: result.orgPermalink,
          postalServer: result.serverPermalink,
          postalDomainId: result.domainId,
          postalApiKey: result.apiKey,
          dkimName: result.dns.dkimName,
          dnsRecords: result.dns satisfies DomainDnsInfo,
        },
      });
    }

    if (wantsSmtp && !mailbox) {
      mailbox = await resolveMailbox({
        sendMode,
        source: mailboxSource,
        ref: parsed.data.mailboxRef,
        target: parsed.data.mailboxTarget,
        name: parsed.data.mailboxName,
        username: parsed.data.mailboxUsername,
        provisioned,
      });
    }

    await prisma.accessKey.update({
      where: { id: accessKey.id },
      data: {
        // API-provisioned keys wait on DNS; a mailbox-only key is usable at once.
        status: wantsApi ? "dns_pending" : "active",
        smtpOrg: mailbox?.orgPermalink ?? null,
        smtpServer: mailbox?.serverPermalink ?? null,
        smtpCredentialId: mailbox?.id ?? null,
        smtpMailbox: mailbox?.name ?? null,
        smtpUsername: mailbox?.username ?? null,
        smtpPassword: mailbox?.password ?? null,
        smtpHost: mailbox?.host ?? null,
        smtpPort: mailbox?.port ?? null,
      },
    });

    revalidatePath("/admin/keys");
    revalidatePath("/admin");
    return {
      key,
      mode: sendMode,
      provider: "postal",
      mailbox: mailbox
        ? { name: mailbox.name, username: mailbox.username, password: mailbox.password, host: mailbox.host, port: mailbox.port }
        : null,
    };
  } catch (e) {
    await prisma.accessKey.update({
      where: { id: accessKey.id },
      data: { status: "revoked", revokedAt: new Date() },
    });
    const msg = e instanceof Error ? e.message : "Provisioning failed";
    return { error: `${msg}. The key was reserved but not provisioned — please retry.` };
  }
}

// Loads the Postal mail servers + existing SMTP mailboxes for the create form.
export async function listPostalMailboxesAction(): Promise<{
  mailboxes: { ref: string; label: string; domains: string[] }[];
  servers: { ref: string; label: string; domains: string[] }[];
  error?: string;
}> {
  await requireAdmin();
  try {
    const { mailboxes, servers } = await listMailboxes();
    return {
      mailboxes: mailboxes.map((m) => ({
        ref: `${m.orgPermalink}|${m.serverPermalink}|${m.id}`,
        label: `${m.name} — ${m.orgPermalink}/${m.serverPermalink}`,
        domains: m.domains,
      })),
      servers: servers.map((s) => ({
        ref: `${s.orgPermalink}|${s.serverPermalink}`,
        label: `${s.serverName} — ${s.orgPermalink}/${s.serverPermalink}`,
        domains: s.domains,
      })),
    };
  } catch (e) {
    return { mailboxes: [], servers: [], error: e instanceof Error ? e.message : "Could not reach Postal" };
  }
}

export async function recheckDomainAction(keyId: string): Promise<{ ok: boolean; status: string }> {
  await requireAdmin();
  const accessKey = await prisma.accessKey.findUnique({ where: { id: keyId } });
  if (!accessKey || !accessKey.postalOrg || !accessKey.postalServer || !accessKey.postalDomainId) {
    return { ok: false, status: "not_provisioned" };
  }
  try {
    const verified = await verifyDomain(accessKey.postalOrg, accessKey.postalServer, accessKey.postalDomainId);
    if (!verified) return { ok: false, status: accessKey.status };
    await prisma.accessKey.update({ where: { id: keyId }, data: { status: "active" } });
    revalidatePath("/admin/keys");
    return { ok: true, status: "active" };
  } catch {
    return { ok: false, status: accessKey.status };
  }
}

// Re-runs Cloudflare Email Routing provisioning for a key. Useful after the
// destination address has been verified (the first run only sends the
// verification email) or after the admin fixes the token's permissions.
export async function recheckCloudflareRoutingAction(keyId: string): Promise<{
  ok: boolean;
  status?: string | null;
  records?: RoutingDnsRecord[];
  note?: string | null;
  ruleId?: string | null;
  error?: string | null;
}> {
  await requireAdmin();
  const accessKey = await prisma.accessKey.findUnique({ where: { id: keyId } });
  if (!accessKey || accessKey.provider !== "cloudflare") {
    return { ok: false, error: "This is not a Cloudflare key." };
  }
  if (!accessKey.inboxAddress || !accessKey.inboundForwardTo) {
    return { ok: false, error: "No inbound address is configured for this key." };
  }

  const credentials = cloudflareCredentials(accessKey);
  if (!credentials.accountId || !credentials.apiToken) {
    return { ok: false, error: "Cloudflare account ID or API token is missing." };
  }

  try {
    const routing = await provisionCloudflareRouting({
      credentials,
      domain: accessKey.domain,
      zoneId: accessKey.cloudflareZoneId,
      address: accessKey.inboxAddress,
      forwardTo: accessKey.inboundForwardTo,
      name: `EVM Sentinel — ${accessKey.name}`,
    });
    await prisma.accessKey.update({
      where: { id: keyId },
      data: {
        cloudflareZoneId: routing.zoneId,
        cloudflareRuleId: routing.ruleId,
        emailRoutingStatus: routing.status,
        emailRoutingRecords: routing.records as unknown as Prisma.InputJsonValue,
        emailRoutingNote: routing.note,
        emailRoutingError: null,
        emailRoutingCheckedAt: new Date(),
      },
    });
    revalidatePath("/admin/keys");
    return {
      ok: true,
      status: routing.status,
      records: routing.records,
      note: routing.note,
      ruleId: routing.ruleId,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Cloudflare Email Routing setup failed";
    await prisma.accessKey.update({
      where: { id: keyId },
      data: {
        emailRoutingStatus: "error",
        emailRoutingError: error,
        emailRoutingCheckedAt: new Date(),
      },
    });
    revalidatePath("/admin/keys");
    return { ok: false, status: "error", error };
  }
}

// Adds (or replaces) the inbound half of an existing Cloudflare key. Outbound
// sending already works; this only creates the Email Routing rule and stores
// the address pair so the admin card can re-check it later.
export async function setupCloudflareInboundAction(
  keyId: string,
  input: { inboxAddress: string; forwardTo: string; zoneId?: string },
): Promise<{
  ok: boolean;
  inboxAddress?: string;
  forwardTo?: string;
  status?: string | null;
  records?: RoutingDnsRecord[];
  note?: string | null;
  error?: string | null;
}> {
  await requireAdmin();
  const accessKey = await prisma.accessKey.findUnique({ where: { id: keyId } });
  if (!accessKey || accessKey.provider !== "cloudflare") {
    return { ok: false, error: "This is not a Cloudflare key." };
  }

  const inboxAddress = normalizeInboxAddress(input.inboxAddress, accessKey.domain);
  const forwardTo = (input.forwardTo || "").trim().toLowerCase();
  if (!inboxAddress) return { ok: false, error: "Enter an inbox address." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inboxAddress)) {
    return { ok: false, error: "Enter a valid inbox address, e.g. hello@acme.com." };
  }
  if (!inboxAddress.endsWith(`@${accessKey.domain}`)) {
    return { ok: false, error: `The inbox address must be on ${accessKey.domain}.` };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardTo)) {
    return { ok: false, error: "Enter a valid forwarding address, e.g. owner@gmail.com." };
  }

  const credentials = cloudflareCredentials(accessKey);
  if (!credentials.accountId || !credentials.apiToken) {
    return { ok: false, error: "Cloudflare account ID or API token is missing." };
  }

  try {
    const routing = await provisionCloudflareRouting({
      credentials,
      domain: accessKey.domain,
      zoneId: input.zoneId || accessKey.cloudflareZoneId,
      address: inboxAddress,
      forwardTo,
      name: `EVM Sentinel — ${accessKey.name}`,
    });
    await prisma.accessKey.update({
      where: { id: keyId },
      data: {
        inboxAddress,
        inboundForwardTo: forwardTo,
        cloudflareZoneId: routing.zoneId,
        cloudflareRuleId: routing.ruleId,
        emailRoutingStatus: routing.status,
        emailRoutingRecords: routing.records as unknown as Prisma.InputJsonValue,
        emailRoutingNote: routing.note,
        emailRoutingError: null,
        emailRoutingCheckedAt: new Date(),
      },
    });
    revalidatePath("/admin/keys");
    return {
      ok: true,
      inboxAddress,
      forwardTo,
      status: routing.status,
      records: routing.records,
      note: routing.note,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Cloudflare Email Routing setup failed";
    await prisma.accessKey.update({
      where: { id: keyId },
      data: {
        inboxAddress,
        inboundForwardTo: forwardTo,
        cloudflareZoneId: input.zoneId || accessKey.cloudflareZoneId,
        emailRoutingStatus: "error",
        emailRoutingError: error,
        emailRoutingCheckedAt: new Date(),
      },
    });
    revalidatePath("/admin/keys");
    return { ok: false, inboxAddress, forwardTo, status: "error", error };
  }
}

export async function updateAccessKeyGovernanceAction(
  _prev: AccessKeyFormState | undefined,
  formData: FormData,
): Promise<AccessKeyFormState> {
  await requireAdmin();
  const parsed = accessKeyGovernanceSchema.safeParse({
    dailyLimit: formData.get("dailyLimit"),
    expiresAt: formData.get("expiresAt"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid governance values" };
  const accessKeyId = String(formData.get("accessKeyId") || "");
  if (!accessKeyId) return { error: "Missing access key id" };
  const dailyLimit = parsed.data.dailyLimit ?? null;
  const expiresAt = parsed.data.expiresAt ?? null;
  await prisma.accessKey.update({
    where: { id: accessKeyId },
    data: { dailyLimit, expiresAt },
  });
  revalidatePath("/admin/keys");
  return { ok: true };
}

export async function revokeAccessKeyAction(keyId: string): Promise<{ ok: boolean }> {
  await requireAdmin();
  await prisma.accessKey.update({
    where: { id: keyId },
    data: { status: "revoked", revokedAt: new Date() },
  });
  revalidatePath("/admin/keys");
  return { ok: true };
}

// Adds another SMTP server to a custom-SMTP access key. The dispatcher starts
// including it in the rotation on the next campaign batch.
export async function addSmtpEndpointAction(
  keyId: string,
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const accessKey = await prisma.accessKey.findUnique({ where: { id: keyId } });
  if (!accessKey || !(accessKey.provider === "smtp" || accessKey.provider === "custom")) {
    return { ok: false, error: "This key is not a custom SMTP key." };
  }
  const check = smtpEndpointSchema.safeParse(input);
  if (!check.success) {
    return { ok: false, error: check.error.issues[0]?.message || "Invalid SMTP credentials" };
  }
  const endpoint = check.data;
  const count = await prisma.smtpEndpoint.count({ where: { accessKeyId: keyId } });
  if (count >= 25) return { ok: false, error: "Up to 25 SMTP servers per key" };
  await prisma.smtpEndpoint.create({
    data: {
      accessKeyId: keyId,
      label: endpoint.label ?? null,
      host: endpoint.host,
      port: Number(endpoint.port),
      username: endpoint.username,
      password: endpoint.password,
    },
  });
  // Mirror the first endpoint onto the legacy columns when they are empty.
  if (!accessKey.smtpHost) {
    await prisma.accessKey.update({
      where: { id: keyId },
      data: {
        smtpHost: endpoint.host,
        smtpPort: Number(endpoint.port),
        smtpUsername: endpoint.username,
        smtpPassword: endpoint.password,
      },
    });
  }
  resetSmtpRotation(keyId);
  revalidatePath("/admin/keys");
  revalidatePath("/dashboard/smtp");
  return { ok: true };
}

export async function removeSmtpEndpointAction(endpointId: string): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const endpoint = await prisma.smtpEndpoint.findUnique({ where: { id: endpointId }, include: { accessKey: true } });
  if (!endpoint) return { ok: false, error: "SMTP server not found" };
  if (!(endpoint.accessKey.provider === "smtp" || endpoint.accessKey.provider === "custom")) {
    return { ok: false, error: "Not a custom SMTP endpoint" };
  }
  await prisma.smtpEndpoint.delete({ where: { id: endpointId } });
  // If the removed endpoint was mirrored on the key, re-mirror the next one.
  if (endpoint.accessKey.smtpHost === endpoint.host) {
    const next = await prisma.smtpEndpoint.findFirst({ where: { accessKeyId: endpoint.accessKeyId }, orderBy: { createdAt: "asc" } });
    await prisma.accessKey.update({
      where: { id: endpoint.accessKeyId },
      data: next
        ? { smtpHost: next.host, smtpPort: next.port, smtpUsername: next.username, smtpPassword: next.password }
        : { smtpHost: null, smtpPort: null, smtpUsername: null, smtpPassword: null },
    });
  }
  resetSmtpRotation(endpoint.accessKeyId);
  revalidatePath("/admin/keys");
  revalidatePath("/dashboard/smtp");
  return { ok: true };
}

// Pause/resume an endpoint without deleting it. A paused endpoint leaves the
// rotation immediately; resuming clears its failure history.
export async function toggleSmtpEndpointAction(endpointId: string, active: boolean): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const endpoint = await prisma.smtpEndpoint.findUnique({ where: { id: endpointId }, include: { accessKey: true } });
  if (!endpoint) return { ok: false, error: "SMTP server not found" };
  if (!(endpoint.accessKey.provider === "smtp" || endpoint.accessKey.provider === "custom")) {
    return { ok: false, error: "Not a custom SMTP endpoint" };
  }
  await prisma.smtpEndpoint.update({
    where: { id: endpointId },
    data: { active, failCount: 0, disabledAt: null },
  });
  resetSmtpRotation(endpoint.accessKeyId);
  revalidatePath("/admin/keys");
  revalidatePath("/dashboard/smtp");
  return { ok: true };
}
