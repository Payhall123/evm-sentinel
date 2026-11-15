"use client";

import { useEffect, useRef, useState } from "react";

type Campaign = {
  id: string;
  status: string;
  subject: string;
  totalCount: number;
  sentCount: number;
  failedCount: number;
};

type ToastState = { campaign: Campaign; live: boolean };

const ACTIVE = new Set(["queued", "sending"]);
const HIDE_AFTER_MS = 10_000;
const SAMPLE_WINDOW = 8;

function formatSpeed(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0/s";
  if (rate >= 10) return `${Math.round(rate)}/s`;
  return `${rate.toFixed(1)}/s`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${secs}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Floating, live-updating send progress toast. Polls /api/campaigns/active once
// a second and renders the count, throughput and a progress bar in real time;
// when the campaign stops being active it flashes a completion state and hides.
export function SendToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [rate, setRate] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const trackedId = useRef<string | null>(null);
  const samples = useRef<Array<{ t: number; done: number }>>([]);
  const hideAt = useRef(0);
  const latest = useRef<ToastState | null>(null);
  const dismissedRef = useRef(false);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      let campaign: Campaign | null = null;
      try {
        const res = await fetch("/api/campaigns/active", { cache: "no-store" });
        if (!res.ok) return;
        campaign = ((await res.json()) as { campaign: Campaign | null }).campaign;
      } catch {
        return;
      }
      if (stopped) return;

      const current = latest.current;

      if (campaign && ACTIVE.has(campaign.status)) {
        trackedId.current = campaign.id;
        hideAt.current = 0;

        // A newly started campaign re-opens a previously dismissed toast.
        if (dismissedRef.current && current?.campaign.id !== campaign.id) {
          dismissedRef.current = false;
          setDismissed(false);
        }

        // Rolling window so the displayed speed reflects the last few seconds.
        const done = campaign.sentCount + campaign.failedCount;
        samples.current.push({ t: Date.now(), done });
        if (samples.current.length > SAMPLE_WINDOW) samples.current.shift();
        const s = samples.current;
        if (s.length >= 2) {
          const first = s[0];
          const last = s[s.length - 1];
          const dt = (last.t - first.t) / 1000;
          setRate(dt > 0 ? Math.max(0, (last.done - first.done) / dt) : 0);
        }

        const next = { campaign, live: true };
        latest.current = next;
        setToast(next);
        return;
      }

      // Not active any more: if we were watching this campaign, it just ended.
      if (current?.live && trackedId.current) {
        const finished = campaign && campaign.id === trackedId.current ? campaign : current.campaign;
        trackedId.current = null;
        samples.current = [];
        setRate(0);
        hideAt.current = Date.now() + HIDE_AFTER_MS;
        const next = { campaign: finished, live: false };
        latest.current = next;
        setToast(next);
        return;
      }

      // Drop a finished toast once its grace period lapses.
      if (current && !current.live && hideAt.current && Date.now() > hideAt.current) {
        latest.current = null;
        setToast(null);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!toast || dismissed) return null;

  const c = toast.campaign;
  const done = c.sentCount + c.failedCount;
  const total = c.totalCount || 0;
  const remaining = Math.max(0, total - done);
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const eta = toast.live && rate > 0 ? remaining / rate : 0;
  const failedTone = c.status === "failed";

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 w-80 max-w-[calc(100vw-2.5rem)]">
      <div className="pointer-events-auto overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur">
        <div className="flex items-start justify-between gap-2 px-4 pt-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
              {toast.live ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                  </span>
                  Sending
                </>
              ) : (
                <span className={failedTone ? "text-red-400" : "text-emerald-400"}>
                  {failedTone ? "Send failed" : c.status === "partial" ? "Finished with errors" : "Send complete"}
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate text-sm font-medium text-white">{c.subject || "Campaign"}</p>
          </div>
          {!toast.live && (
            <button
              type="button"
              onClick={() => {
                dismissedRef.current = true;
                setDismissed(true);
              }}
              className="text-zinc-500 transition-colors hover:text-zinc-200"
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>

        <div className="px-4 pt-3">
          <div className="flex items-end justify-between">
            <p className="text-2xl font-semibold tabular-nums text-white">
              {done.toLocaleString()}
              <span className="ml-1 text-sm font-normal text-zinc-500">/ {total.toLocaleString()}</span>
            </p>
            {toast.live && <p className="text-sm font-medium tabular-nums text-cyan-300">{formatSpeed(rate)}</p>}
          </div>

          <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width] duration-700 ease-linear ${
                toast.live
                  ? "bg-gradient-to-r from-cyan-500 to-cyan-300"
                  : failedTone
                    ? "bg-red-500"
                    : "bg-emerald-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="flex items-center justify-between py-3 text-xs text-zinc-400">
            <span className="tabular-nums">
              {Math.round(pct)}%
              {c.failedCount > 0 && <span className="text-red-400"> · {c.failedCount.toLocaleString()} failed</span>}
            </span>
            <span className="tabular-nums">
              {toast.live
                ? remaining > 0
                  ? `${remaining.toLocaleString()} left · ~${formatEta(eta)}`
                  : "finishing…"
                : `${c.sentCount.toLocaleString()} sent`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
