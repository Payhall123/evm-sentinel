"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addSmtpEndpointAction, removeSmtpEndpointAction, toggleSmtpEndpointAction } from "@/app/actions/admin";
import { Button, Input, Label, Select } from "@/components/ui";

export type SmtpEndpointView = {
  id: string;
  label: string | null;
  host: string;
  port: number;
  username: string;
  active: boolean;
  failCount: number;
  disabledAt: string | null; // ISO string
};

type Props = {
  accessKeyId: string;
  endpoints: SmtpEndpointView[];
};

// Manage the SMTP servers attached to a custom-SMTP access key. Adding,
// pausing and removing endpoints all feed the dispatcher's round-robin
// rotation; the failure counter comes from the dispatcher's circuit breaker.
export function SmtpEndpointsManager({ accessKeyId, endpoints }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ label: "", host: "", port: "587", username: "", password: "" });

  function resetForm() {
    setForm({ label: "", host: "", port: "587", username: "", password: "" });
    setShowAdd(false);
    setError(null);
  }

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(id);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) setError(result.error || "Could not update the SMTP server");
      else router.refresh();
    } catch {
      setError("Could not update the SMTP server — try again");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-300">
          SMTP servers ({endpoints.filter((e) => e.active).length} active / {endpoints.length})
        </p>
        <button
          type="button"
          onClick={() => setShowAdd((s) => !s)}
          className="rounded-lg border border-cyan-600/40 bg-cyan-600/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-600/20"
        >
          {showAdd ? "Cancel" : "+ Add SMTP server"}
        </button>
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Sends rotate across the active servers, so no single provider takes every message. A server that fails
        repeatedly is set aside (trip count resets after ~15 minutes) and the rest keep sending.
      </p>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {showAdd && (
        <div className="mb-4 grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3 sm:grid-cols-2">
          <div>
            <Label>Label (optional)</Label>
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Spacemail #2" autoComplete="off" />
          </div>
          <div>
            <Label>SMTP Host</Label>
            <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.spacemail.com" />
          </div>
          <div>
            <Label>Port</Label>
            <Select value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })}>
              <option value="587">587 — STARTTLS</option>
              <option value="465">465 — implicit TLS</option>
              <option value="25">25 — plain/STARTTLS</option>
              <option value="2525">2525 — alternate STARTTLS</option>
            </Select>
          </div>
          <div>
            <Label>Username</Label>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username or email" autoComplete="off" />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="password" autoComplete="new-password" />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              disabled={!form.host.trim() || !form.username.trim() || !form.password.trim() || busy !== null}
              onClick={async () => {
                await run("add", () =>
                  addSmtpEndpointAction(accessKeyId, {
                    label: form.label.trim() || null,
                    host: form.host.trim(),
                    port: Number(form.port) || 587,
                    username: form.username.trim(),
                    password: form.password,
                  }),
                ).then(() => resetForm());
              }}
            >
              {busy === "add" ? "Adding…" : "Add server"}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {endpoints.map((e) => {
          const paused = !e.active;
          const cooling = e.disabledAt && new Date(e.disabledAt).getTime() > Date.now();
          return (
            <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-200">
                  {e.label ? `${e.label} — ` : ""}
                  {e.host}:{e.port} <span className="text-zinc-500">({e.username})</span>
                </p>
                <p className="text-xs text-zinc-500">
                  {paused
                    ? "Paused — not in the rotation"
                    : cooling
                      ? "Cooling down after repeated failures — rejoins automatically"
                      : e.failCount > 0
                        ? `${e.failCount} recent failure${e.failCount === 1 ? "" : "s"}`
                        : "Healthy"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => run(e.id, () => toggleSmtpEndpointAction(e.id, !e.active))}
                  className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {busy === e.id ? "…" : paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  disabled={busy === e.id}
                  onClick={() => {
                    if (window.confirm(`Remove ${e.host}:${e.port} from this key?`)) {
                      run(e.id, () => removeSmtpEndpointAction(e.id));
                    }
                  }}
                  className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
