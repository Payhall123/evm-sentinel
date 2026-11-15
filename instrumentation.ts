// Starts the local in-process dispatcher once when a long-running Next.js
// server boots. Vercel functions are ephemeral, so on Vercel campaign dispatch
// is driven by /api/cron/dispatch instead.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL) return;

  const { ensureDispatcherRunning } = await import("./lib/dispatcher");
  ensureDispatcherRunning();
}
