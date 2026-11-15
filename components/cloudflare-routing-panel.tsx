"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { recheckCloudflareRoutingAction } from "@/app/actions/admin";
import { Badge, type Tone } from "@/components/ui";

type DnsRecord = {
  type?: string | null;
  name?: string | null;
  content?: string | null;
  priority?: number | null;
};

type Props = {
  accessKeyId: string;
  inboxAddress: string;
  forwardTo: string | null;
  status: string | null;
  records: DnsRecord[];
  note: string | null;
  error: string | null;
  checkedAt: string | null;
};

function statusTone(status: string | null): Tone {
  switch (status) {
    case "active":
      return "green";
    case "pending":
    case "pending_verification":
    case "manual":
      return "amber";
    case "error":
      return "red";
    default:
      return "zinc";
  }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "active":
      return "routing active";
    case "pending_verification":
      return "destination unverified";
    case "pending":
      return "pending";
    case "manual":
      return "manual setup needed";
    case "error":
      return "setup error";
    default:
      return "not configured";
  }
}

export function CloudflareRoutingPanel({
  accessKeyId,
  inboxAddress,
  forwardTo,
  status,
  records,
  note,
  error,
  checkedAt,
}: Props) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [localStatus, setLocalStatus] = useState(status);
  const [localRecords, setLocalRecords] = useState(records);
  const [localNote, setLocalNote] = useState(note);
  const [localError, setLocalError] = useState(error);
  const [result, setResult] = useState<string | null>(null);

  async function recheck() {
    setChecking(true);
    setResult(null);
    try {
      const res = await recheckCloudflareRoutingAction(accessKeyId);
      if (res.ok) {
        setLocalStatus(res.status || "active");
        setLocalRecords(res.records || []);
        setLocalNote(res.note || null);
        setLocalError(null);
        setResult(
          res.status === "active"
            ? "Routing is active — Cloudflare will forward mail to the destination."
            : "Re-checked. Cloudflare still needs the destination address verified.",
        );
      } else {
        setLocalStatus(res.status || "error");
        setLocalError(res.error || "Re-check failed.");
        setResult("Re-check failed — see the error above.");
      }
      router.refresh();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Re-check failed — try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg bg-zinc-950 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="font-medium text-zinc-300">Cloudflare Email Routing</p>
          <Badge tone={statusTone(localStatus)}>{statusLabel(localStatus)}</Badge>
        </div>
        <button
          type="button"
          onClick={recheck}
          disabled={checking}
          className="rounded-lg border border-cyan-600/40 bg-cyan-600/10 px-2.5 py-1 text-[11px] font-medium text-cyan-300 hover:bg-cyan-600/20 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Re-check routing"}
        </button>
      </div>

      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-600">Receives at</dt>
        <dd className="break-all text-zinc-300">{inboxAddress}</dd>
        <dt className="text-zinc-600">Forwards to</dt>
        <dd className="break-all text-zinc-300">{forwardTo || "—"}</dd>
        {checkedAt && (
          <>
            <dt className="text-zinc-600">Last check</dt>
            <dd className="text-zinc-400">
              {new Date(checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC
            </dd>
          </>
        )}
      </dl>

      {localError && <p className="mt-2 text-red-300">{localError}</p>}
      {localNote && <p className="mt-2 text-amber-300">{localNote}</p>}
      {result && <p className="mt-2 text-cyan-300">{result}</p>}

      {localRecords.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-zinc-800 pt-3">
          <p className="font-medium text-zinc-400">Routing DNS records</p>
          {localRecords.map((r, i) => (
            <div
              key={`${r.type}-${r.name}-${i}`}
              className="grid grid-cols-[3rem_8rem_1fr] items-start gap-2"
            >
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-center font-semibold text-zinc-300">
                {r.type}
              </span>
              <code className="break-all text-zinc-400">
                {r.name}
                {r.priority != null ? ` (${r.priority})` : ""}
              </code>
              <code className="break-all text-zinc-300">{r.content}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
