import { z } from "zod";

export const emailSchema = z.email("Please enter a valid email address");

export const accessKeyCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  // Which Postal resource the customer uses: "api" (HTTP API credential, the
  // original behaviour), "smtp" (an attached SMTP mailbox only) or "both".
  sendMode: z.enum(["api", "smtp", "both"]).default("api"),
  // Upstream transport. "postal" provisions/attaches Postal resources (default);
  // "devner" relays through the Devner API and ignores the mailbox fields;
  // "ses" sends through the customer's own Amazon SES account; "elasticemail"
  // sends through the customer's own Elastic Email account using the API key
  // supplied below; "resend" sends through the customer's own Resend account;
  // "mailgun" sends through the customer's own Mailgun account/domain.
  // "smtp" sends through a generic/custom SMTP provider; "zeptomail" uses the
  // ZeptoMail (Zoho CPaaS) SMTP relay with its fixed host/port defaults.
  // "cloudflare" sends through Cloudflare Email Service's REST API and can
  // optionally receive mail through Cloudflare Email Routing — no SMTP at all.
  provider: z.enum(["postal", "devner", "ses", "elasticemail", "resend", "mailgun", "smtp", "custom", "zeptomail", "cloudflare"]).default("postal"),
  // Optional per-key Devner API key (sl_...). When omitted, DEVNER_API_KEY is used.
  devnerApiKey: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Per-key Elastic Email API key, sent as X-ElasticEmail-ApiKey. Stored on the
  // access key so each user sends through their own Elastic Email account.
  elasticEmailApiKey: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Per-key Resend API key (re_...), sent as an Authorization: Bearer token.
  // Stored on the access key so each user sends through their own Resend
  // account.
  resendApiKey: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Per-key Mailgun API key and optional API endpoint. The access key's domain
  // is used as the Mailgun sending domain in /v3/<domain>/messages.
  mailgunApiKey: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  mailgunApiBase: z
    .union([
      z
        .string()
        .trim()
        .max(300)
        .refine(
          (v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v),
          "Enter a Mailgun API base URL starting with https://",
        ),
      z.null(),
    ])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Amazon SES credentials. Region + IAM access key/secret drive the SES v2
  // API; the SMTP username/password are optional because the password can be
  // derived from the secret access key at creation time.
  sesRegion: z
    .union([z.string().trim().max(40), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  sesAccessKeyId: z
    .union([z.string().trim().max(200), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  sesSecretAccessKey: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  sesSmtpUsername: z
    .union([z.string().trim().max(200), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  sesSmtpPassword: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  sesSmtpPort: z
    .union([z.string().trim().transform((v) => (v === "" ? null : Number(v))), z.number(), z.null()])
    .refine((v) => v === null || [25, 465, 587, 2465].includes(v), "Choose an SES SMTP port (25, 465, 587 or 2465)")
    .optional(),
  sesConfigurationSet: z
    .union([z.string().trim().max(200), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Cloudflare Email Service. The account id + API token authenticate the REST
  // send; both fall back to CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN when
  // left empty. The optional inbox fields create an Email Routing rule.
  cloudflareAccountId: z
    .union([z.string().trim().max(64), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  cloudflareApiToken: z
    .union([z.string().trim().max(500), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  cloudflareZoneId: z
    .union([z.string().trim().max(64), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Accepts either a full address (hello@acme.com) or a local part (hello);
  // the action appends the access key's domain to a local part.
  inboxAddress: z
    .union([z.string().trim().max(200), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  inboundForwardTo: z
    .union([z.string().trim().email("Invalid forwarding address"), z.literal(""), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Required unless sendMode is "smtp", where it is derived from the attached
  // mailbox's mail server if left blank.
  domain: z
    .string()
    .trim()
    .transform((v) => v.toLowerCase())
    .refine((v) => v === "" || /^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v), "Enter a valid domain, e.g. example.com")
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Mailbox attachment. "existing" resolves mailboxRef ("org|server|uuid"),
  // "new" creates a credential named mailboxName on mailboxTarget ("org|server").
  mailboxSource: z.enum(["new", "existing"]).optional(),
  mailboxRef: z.string().trim().max(400).optional(),
  mailboxTarget: z.string().trim().max(400).optional(),
  mailboxName: z.string().trim().max(120).optional(),
  mailboxUsername: z.string().trim().max(200).optional(),
  // Optional per-key governance. dailyLimit caps how many messages this key may
  // send per UTC day; expiresAt hard-stops the key after that moment.
  dailyLimit: z
    .union([z.string().trim().transform((v) => (v === "" ? null : Number(v))), z.number(), z.null()])
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10_000_000), "Enter a whole number (0–10M) to cap messages per day, or leave empty")
    .optional(),
  expiresAt: z
    .union([
      z.string().trim().refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "Enter a valid date/time, or leave empty"),
      z.date(),
      z.null(),
    ])
    .transform((v) => (v === "" || typeof v === "string" ? (v === "" ? null : new Date(v)) : v)) // empty -> null
    .refine((v) => v === null || v.getTime() > Date.now(), "Expiry must be in the future")
    .optional(),
});

// One SMTP server a custom-SMTP key may send through. A key can be created
// with several of these so the dispatcher can rotate across them.
export const smtpEndpointSchema = z.object({
  label: z
    .union([z.string().trim().max(120), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  host: z.string().trim().min(1, "SMTP host is required").max(253),
  port: z
    .union([z.string().trim().transform((v) => Number(v)), z.number()])
    .refine((v) => Number.isInteger(v) && [25, 465, 587, 2525].includes(v), "Choose an SMTP port (25, 465, 587 or 2525)"),
  username: z.string().trim().min(1, "SMTP username is required").max(200),
  password: z.string().trim().min(1, "SMTP password is required").max(500),
});

// The JSON payload posted by the create form (and used by addSmtpEndpointAction).
export const smtpEndpointsSchema = z
  .array(smtpEndpointSchema)
  .min(1, "Add at least one SMTP server (host, port, username, password).")
  .max(25, "Up to 25 SMTP servers per key");

// When a customer updates a key's governance after creation.
export const accessKeyGovernanceSchema = z.object({
  dailyLimit: z
    .union([z.string().trim().transform((v) => (v === "" ? null : Number(v))), z.number(), z.null()])
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10_000_000), "Enter a whole number (0–10M) to cap messages per day, or leave empty")
    .optional(),
  expiresAt: z
    .union([
      z.string().trim().refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "Enter a valid date/time, or leave empty"),
      z.date(),
      z.null(),
    ])
    .transform((v) => (v === "" || typeof v === "string" ? (v === "" ? null : new Date(v)) : v))
    .refine((v) => v === null || v.getTime() > Date.now(), "Expiry must be in the future")
    .optional(),
});

export const senderSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Invalid email"),
  name: z
    .union([z.string().trim().max(120), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
  replyTo: z
    .union([z.string().trim().email("Invalid reply-to email"), z.literal(""), z.null()])
    .transform((v) => (v === "" ? null : v))
    .optional(),
});

export const letterSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    subject: z.string().trim().min(1, "Subject is required").max(500),
    // The editor is intentionally single-format: the selected body is what gets
    // sent. This prevents a plain-text letter from being turned into HTML by the
    // optimizer or by a leftover body from the other field.
    bodyFormat: z.enum(["html", "text"]).default("html"),
    htmlBody: z.string().max(500_000).default(""),
    plainText: z
      .union([z.string().trim(), z.null()])
      .transform((v) => (v === "" ? null : v))
      .optional(),
  })
  .refine(
    (v) => (v.bodyFormat === "text" ? !!v.plainText : v.htmlBody.trim().length > 0),
    "Add a body for the selected format",
  );

export const campaignSchema = z.object({
  letterId: z.string().min(1),
  listId: z.string().min(1),
  senderId: z.string().min(1).optional(),
  // Optional so Devner-mode campaigns can omit it (Devner assigns the sender).
  fromEmail: z
    .union([z.string().trim().email("Invalid from email"), z.literal(""), z.null()])
    .optional(),
  fromName: z.string().trim().max(120).optional(),
  replyTo: z.string().email("Invalid reply-to").optional().or(z.literal("")),
});