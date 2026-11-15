"use client";

import { useEffect, useRef, useState, useActionState } from "react";
import { useRouter } from "next/navigation";
import { createListAction } from "@/app/actions/contacts";
import { Button, Input, Label } from "@/components/ui";
import { parseImportFiles } from "@/lib/import-client";

type Job = {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  fileCount: number;
  totalBytes: number;
  totalCount: number;
  processedCount: number;
  skippedCount: number;
  error: string | null;
};

type Phase = "idle" | "uploading" | "processing" | "done" | "error";

// Small enough to stay far below Vercel's request-body limit, large enough that
// a 50k-contact list only needs 100 requests.
const BATCH_SIZE = 500;

export default function ImportCsvForm({ lists }: { lists: { id: string; name: string }[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [listId, setListId] = useState("");
  const [listState, createListFormAction, createListPending] = useActionState(createListAction, undefined);

  const [phase, setPhase] = useState<Phase>("idle");
  const [large, setLarge] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the import job until it finishes, so the user sees the list fill up in
  // real time instead of staring at a frozen "Importing…" button.
  useEffect(() => {
    if (phase !== "processing" || !jobId) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/contacts/import/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Job;
        if (cancelled) return;
        setJob(data);
        if (data.status === "done" || data.status === "failed") {
          setPhase("done");
          if (data.status === "done") {
            if (fileRef.current) fileRef.current.value = "";
            router.refresh();
          }
        }
      } catch {
        // Transient network hiccup — keep polling on the next tick.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, jobId, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = fileRef.current?.files;
    if (!listId) {
      setError("Choose a list");
      return;
    }
    if (!files || !files.length) {
      setError("No file selected");
      return;
    }

    setError(null);
    setJob(null);
    setJobId(null);
    const fileArray = Array.from(files);
    const bytes = fileArray.reduce((n, f) => n + f.size, 0);
    setLarge(bytes > 1024 * 1024);
    setPhase("uploading");

    let activeJobId: string | null = null;
    try {
      const parsed = await parseImportFiles(fileArray);
      if (parsed.contacts.length === 0) {
        setError(parsed.errors[0] || "No valid contacts found in the selected file(s).");
        setPhase("error");
        return;
      }

      const createRes = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          listId,
          fileCount: fileArray.length,
          totalBytes: bytes,
          totalCount: parsed.contacts.length,
          skippedCount: parsed.skipped,
          errors: parsed.errors.join("\n"),
        }),
      });
      const created = (await createRes.json().catch(() => null)) as
        | { job?: { id: string }; large?: boolean; error?: string }
        | null;
      if (!createRes.ok || !created?.job) {
        setError(created?.error || `Upload failed (${createRes.status})`);
        setPhase("error");
        return;
      }

      activeJobId = created.job.id;
      setLarge(Boolean(created.large));
      setJobId(activeJobId);
      setJob({
        id: activeJobId,
        status: "processing",
        fileCount: fileArray.length,
        totalBytes: bytes,
        totalCount: parsed.contacts.length,
        processedCount: 0,
        skippedCount: parsed.skipped,
        error: parsed.errors.length ? parsed.errors.join("\n") : null,
      });
      setPhase("processing");

      for (let i = 0; i < parsed.contacts.length; i += BATCH_SIZE) {
        const chunk = parsed.contacts.slice(i, i + BATCH_SIZE);
        const batchRes = await fetch(`/api/contacts/import/${activeJobId}/batch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contacts: chunk }),
        });
        const progress = (await batchRes.json().catch(() => null)) as
          | { processedCount?: number; error?: string }
          | null;
        if (!batchRes.ok) {
          throw new Error(progress?.error || `Import failed (${batchRes.status})`);
        }
        setJob((prev) =>
          prev ? { ...prev, processedCount: progress?.processedCount ?? prev.processedCount } : prev,
        );
      }

      const completeRes = await fetch(`/api/contacts/import/${activeJobId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!completeRes.ok) throw new Error("Import finished but the job could not be closed.");

      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "done",
              processedCount: parsed.contacts.length,
              totalCount: parsed.contacts.length,
              error: parsed.errors.length ? parsed.errors.join("\n") : null,
            }
          : prev,
      );
      setPhase("done");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      if (activeJobId) {
        await fetch(`/api/contacts/import/${activeJobId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "failed", error: message }),
        }).catch(() => {});
      }
      setError(message);
      setPhase("error");
    }
  }

  const busy = phase === "uploading" || phase === "processing";
  const total = job?.totalCount ?? 0;
  const processed = job?.processedCount ?? 0;
  const skipped = job?.skippedCount ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  // Total is unknown until the worker has parsed the file ("preparing"), so the
  // bar pulses until real progress is available.
  const indeterminate = phase === "uploading" || (phase === "processing" && total === 0);

  return (
    <div>
      <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="mb-2 text-sm font-medium text-white">New list</h3>
        <form action={createListFormAction} className="flex gap-2">
          <Input name="name" required placeholder="e.g. Webinar leads" />
          <Button type="submit" disabled={createListPending}>Create</Button>
        </form>
        {listState?.error && <p className="mt-2 text-sm text-red-400">{listState.error}</p>}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="mb-2 text-sm font-medium text-white">Upload into a list</h3>
        <p className="mb-3 text-xs text-zinc-500">
          CSV columns: <code className="text-cyan-300">email</code> (required),{" "}
          <code className="text-cyan-300">first name</code>, <code className="text-cyan-300">last name</code>. Or upload one or more{" "}
          <code className="text-cyan-300">.txt</code> files with one or more emails per line.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Target list</Label>
            <select
              name="listId"
              value={listId}
              onChange={(e) => setListId(e.target.value)}
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-cyan-500 focus:outline-none"
            >
              <option value="">Select a list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Files (CSV or TXT)</Label>
            <input
              ref={fileRef}
              name="file"
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              multiple
              required
              className="w-full text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-sm file:text-zinc-200 hover:file:bg-zinc-700"
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Importing…" : "Import files"}
          </Button>
        </form>

        {(phase === "uploading" || phase === "processing") && (
          <div className="mt-4 space-y-2 rounded-lg border border-cyan-900/50 bg-cyan-950/30 p-3 text-sm">
            {large && (
              <p className="font-medium text-amber-300">
                File exceeds normal rate for contacts — processing and preparing EVM for batch upload.
              </p>
            )}
            <p className="text-cyan-200">
              {phase === "uploading"
                ? "Uploading files…"
                : total === 0
                  ? "Processing and preparing EVM for batch upload…"
                  : "Importing contacts…"}
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full bg-cyan-500 transition-all duration-300 ${indeterminate ? "w-full animate-pulse" : ""}`}
                style={indeterminate ? undefined : { width: `${percent}%` }}
              />
            </div>
            {!indeterminate && (
              <p className="text-xs text-zinc-400">
                {processed.toLocaleString()} / {total.toLocaleString()} contacts
                {skipped ? ` · ${skipped.toLocaleString()} skipped` : ""} · {percent}%
              </p>
            )}
          </div>
        )}

        {phase === "error" && error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {phase === "done" && job && (
          <div className="mt-4 space-y-1 rounded-lg bg-zinc-950 p-3 text-sm">
            {job.status === "done" ? (
              <p className="font-medium text-emerald-400">
                {job.processedCount.toLocaleString()} contact(s) imported
                {job.skippedCount ? ` · ${job.skippedCount.toLocaleString()} skipped` : ""}.
              </p>
            ) : (
              <p className="font-medium text-red-400">Import failed: {job.error || "unknown error"}</p>
            )}
            {job.status === "done" &&
              job.error &&
              job.error
                .split("\n")
                .slice(0, 8)
                .map((e, i) => (
                  <p key={i} className="text-xs text-amber-400">
                    {e}
                  </p>
                ))}
          </div>
        )}
      </div>
    </div>
  );
}
