# Deploying EVMSentinel on Vercel

The app is a Next.js 16 application with Prisma/PostgreSQL. It can run on
Vercel, including the Cloudflare Email Service transport (which uses HTTPS and
does not need SMTP).

## What changed for serverless

- Campaign sending is driven by `GET /api/cron/dispatch`, scheduled in
  `vercel.json`. The old in-process `setInterval` dispatcher is still used on a
  normal long-running host (local dev, Docker, VPS), but it is disabled when
  `VERCEL` is set.
- `lib/job-lock.ts` takes a Postgres lease so overlapping cron invocations do
  not double-send.
- Contact files are parsed in the browser and inserted in small JSON batches.
  No upload is written to local disk, so Vercel's ephemeral filesystem and body
  size limit are not a problem.

## 1. Create a managed Postgres database

Vercel cannot reach `127.0.0.1:5433`. Use Neon, Supabase, Vercel Postgres, or
another managed Postgres.

Use the provider's **pooled** connection string for `DATABASE_URL`. For the
initial schema, run the migration from your machine against the **direct**
connection string:

```bash
DATABASE_URL="<direct connection string>" npm run db:deploy
```

If this is a fresh database and you have not generated migrations yet, run:

```bash
npx prisma db push
```

For production, prefer migrations (`prisma migrate deploy`) so schema changes
are repeatable.

## 2. Configure environment variables

Copy `.env.example` and fill in the values in Vercel Project Settings. At
minimum:

- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `APP_BASE_URL` and `UNSUBSCRIBE_BASE_URL` (public HTTPS origin)
- `UNSUBSCRIBE_SECRET`
- `CRON_SECRET`

For Cloudflare email, add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
(or set them per access key in the admin UI).

## 3. Cron

`vercel.json` schedules `/api/cron/dispatch` every minute:

```json
{
  "crons": [{ "path": "/api/cron/dispatch", "schedule": "* * * * *" }]
}
```

Minute-level cron requires a Vercel plan that supports it (Pro). On Hobby,
change the schedule to a frequency the plan allows; campaign delivery will be
correspondingly slower.

Vercel sends `Authorization: Bearer $CRON_SECRET`. The route also accepts
`?secret=...` for a manual test:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/dispatch
```

If `CRON_SECRET` is unset, the route is open only outside production.

## 4. Send limits

Serverless functions have a maximum duration. The dispatcher is conservative:

- `DISPATCH_BATCH_SIZE` defaults to 25 on Vercel (50 elsewhere)
- `DISPATCH_MAX_CAMPAIGNS_PER_TICK` defaults to 1 on Vercel
- `DISPATCH_TIME_BUDGET_MS` defaults to 45 seconds on Vercel

If a run reaches the budget, it stops between messages. The campaign remains
`sending` and the next cron invocation resumes it. Raise these values only if
your Vercel plan allows a longer function duration.

## 5. SMTP note

HTTP providers (Cloudflare, Resend, Mailgun, SES API, Elastic Email, Devner)
are the safest choice on Vercel. Nodemailer SMTP may work on port 587, but some
networks block outbound SMTP and Vercel does not guarantee it. Cloudflare Email
Service avoids the issue entirely.

## 6. Imports

The upload form parses CSV/TXT in the browser, creates an `ImportJob`, and
POSTs contacts to `/api/contacts/import/<id>/batch` in chunks of 500. The job
is polled for progress and closed by the client. If the browser is closed, the
job is marked failed after 30 minutes.

This means contact data is sent to the app in JSON batches rather than as one
large file. A 50,000-contact list is about 100 small requests.
