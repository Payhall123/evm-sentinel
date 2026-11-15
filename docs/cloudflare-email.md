# Cloudflare Email Service (admin setup)

EVM Sentinel can create an access key whose mail is sent by **Cloudflare Email
Service over its REST API** — there is no SMTP server in the path — and whose
inbound address is handled by **Cloudflare Email Routing**. Both halves are set
up from **Admin → Access keys → New access key → Cloudflare Email Service**.

## What each half does

| Half | Cloudflare product | What EVM Sentinel stores |
| --- | --- | --- |
| Outbound | Email Sending (`POST /accounts/<id>/email/sending/send`) | account id, API token, sending domain |
| Inbound (optional) | Email Routing (MX + forwarding rule) | inbox address, forwarding destination, zone / rule ids |

Outbound is the part that affects whether your campaigns arrive. Inbound only
means the user can receive replies at their own domain; it does not influence
spam placement of outbound mail.

## Before creating the key

1. **Host the domain's DNS on Cloudflare.** Email Service requires Cloudflare
   DNS.
2. **Onboard the sending domain.** Dashboard → Compute → Email Service → Email
   Sending → Onboard Domain. This adds the `cf-bounce` MX/SPF/DKIM records and a
   DMARC record. Allow 5–15 minutes for propagation.
3. **Create an API token.** My Profile → API Tokens → Create Token:
   - `Email Sending: Edit` (required for outbound)
   - `Zone: Read` (zone lookup for inbound)
   - `Zone Settings: Write` (enable Email Routing)
   - `Email Routing Rules: Edit`
   - `Email Routing Addresses: Edit`
4. **Check the plan.** Sending to arbitrary recipients requires Workers Paid.
   New accounts have a low daily quota that grows with good sending history.

## Creating the key

Fill in:

- **Cloudflare account ID** — the account that owns the zone and the onboarded
  sending domain.
- **Cloudflare API token** — from step 3. It is stored on the access key, so
  each user can have their own Cloudflare account. Leave both fields empty to
  fall back to `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`.
- **Sending domain** — must already be onboarded for Email Sending.
- **Also receive mail for the user** (optional):
  - **Inbox address** — `hello` or `hello@yourdomain.com`. A local part is
    completed with the sending domain.
  - **Forward to** — the real inbox (e.g. the user's Gmail). Cloudflare emails a
    verification link to this address.
  - **Zone ID** — optional; looked up from the domain when omitted.

If the destination is not verified yet, the key is still created and outbound
sending works. The card shows **destination unverified** and Cloudflare's
verification email arrives at the forwarding address. After clicking it, use
**Re-check routing** on the access-key card; the rule is created and the card
switches to **routing active**.

An outbound-only Cloudflare key can add inbound later from the same card: enter
the inbox address and forwarding destination under **Receive mail (optional)**
and submit. That runs the same provisioning call.

## Limits worth knowing

- 50 recipients per message (to + cc + bcc), 25 MiB total message size.
- One routing rule maps one address to one destination; 200 rules per domain.
- Sending from a routing domain works before onboarding, but only to verified
  destination addresses. After onboarding, any recipient is allowed.
- Cloudflare keeps its own suppression list and hard-bounce handling. A
  suppressed recipient fails the send; EVM Sentinel also keeps its own
  suppression list for unsubscribes.

## Deliverability — the honest version

No provider can guarantee inbox placement. Cloudflare handles SPF, DKIM,
DMARC, IP reputation and bounce feedback, which removes most of the mechanical
causes of spam filtering. Placement is still decided by:

- domain age and sending history — a brand-new domain is treated cautiously;
- recipient engagement — replies and "not junk" actions help most;
- complaint rate — Cloudflare's guidance is under 0.1%;
- content and list hygiene — no purchased lists, no spam-trigger copy;
- volume ramp — start small and increase over weeks.

Cloudflare Email Service is intended for transactional and expected mail.
Using it for cold bulk outreach can get the account suspended. If the goal is
cold outreach, expect to earn reputation slowly and keep a fallback provider.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `email.sending.error.authentication.forbidden` | Token lacks `Email Sending: Edit`. |
| `email.sending.error.authentication.not_entitled` | Account not on Workers Paid / not entitled. |
| `email.sending.error.email.sending_disabled` | Sending disabled for the zone/account. |
| `email.sending.error.invalid_request_schema` | From-domain not onboarded, or bad recipient/body. |
| Routing status `manual` | Token lacks routing permissions, or Cloudflare rejected the rule. |
| Routing status `pending_verification` | Destination address not verified yet. |
| `Non-Cloudflare MX records exist` | Remove the old provider's MX records before enabling Email Routing. |

Relevant docs:

- <https://developers.cloudflare.com/email-service/get-started/send-emails/>
- <https://developers.cloudflare.com/email-service/api/send-emails/rest-api/>
- <https://developers.cloudflare.com/email-service/configuration/domains/>
- <https://developers.cloudflare.com/email-service/concepts/deliverability/>
