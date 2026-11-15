This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

Vercel works with a managed Postgres database and a cron-driven dispatcher.
See [`docs/vercel.md`](docs/vercel.md) for the required environment variables,
database setup, cron configuration, and serverless limits.

The short version:

1. Point `DATABASE_URL` at a managed Postgres database.
2. Add the values from `.env.example` to Vercel Project Settings.
3. Set `CRON_SECRET`; `vercel.json` schedules `/api/cron/dispatch`.
4. Run `npm run db:deploy` (or `npx prisma db push` for a fresh database).
5. Deploy.

For the Cloudflare Email Service (no SMTP), see
[`docs/cloudflare-email.md`](docs/cloudflare-email.md).
