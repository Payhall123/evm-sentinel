"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { recheckDomainAction, revokeAccessKeyAction } from "@/app/actions/admin";
import { KeyGovernanceForm } from "@/components/key-governance-form";

type Props = {
  accessKeyId: string;
  keyValue: string;
  status: string;
  dailyLimit: number | null;
  expiresAt: Date | null;
};

export function KeyCardActions({ accessKeyId, keyValue, status, dailyLimit, expiresAt }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function revoke() {
    if (!window.confirm("Revoke this access key? Sending is blocked immediately.")) return;
    const result = await revokeAccessKeyAction(accessKeyId);
    if (result.ok) {
      setRevoked(true);
      setOpen(false);
    }
  }

  async function recheck() {
    setRechecking(true);
    setRecheckNote(null);
    setOpen(false);
    try {
      const result = await recheckDomainAction(accessKeyId);
      router.refresh();
      setRecheckNote(
        result.ok ? "DNS verified — key activated!" : result.status === "not_provisioned" ? "Not provisioned for Postal." : "Recheck failed — DNS records not found yet.",
      );
    } catch {
      setRecheckNote("Recheck error — try again.");
    } finally {
      setRechecking(false);
    }
  }

  const canEdit = status === "active";

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label="Access key actions"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm leading-none text-zinc-300 hover:bg-zinc-800"
      >
        ⋯
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
          <button
            type="button"
            onClick={copyKey}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
          >
            {copied ? "Copied!" : "Copy key"}
          </button>
          {status === "dns_pending" && (
            <button
              type="button"
              onClick={recheck}
              disabled={rechecking}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-amber-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {rechecking ? "Rechecking DNS…" : "Recheck DNS"}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setShowEdit((s) => !s);
                setOpen(false);
              }}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
            >
              {showEdit ? "Hide limits & expiry" : "Edit limits & expiry"}
            </button>
          )}
          <button
            type="button"
            onClick={revoke}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-800"
          >
            Revoke key
          </button>
        </div>
      )}

      {showEdit && canEdit && (
        <KeyGovernanceForm accessKeyId={accessKeyId} dailyLimit={dailyLimit} expiresAt={expiresAt} />
      )}
      {revoked && <p className="mt-2 text-[11px] text-red-400">Key revoked.</p>}
      {recheckNote && <p className="mt-2 text-[11px] text-cyan-300">{recheckNote}</p>}
    </div>
  );
}