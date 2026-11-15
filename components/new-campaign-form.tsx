"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createCampaignAction } from "@/app/actions/campaigns";
import { Button, Label, Select } from "@/components/ui";

type Option = { id: string; name: string; count?: number; email?: string; replyTo?: string };

export function NewCampaignForm({ letters, lists, senders, domain, provider }: {
  letters: Option[];
  lists: (Option & { count: number })[];
  senders: (Option & { email: string })[];
  domain: string;
  provider: string;
}) {
  const isDevner = provider === "devner";
  const actionFn = async (_: { error?: string } | undefined, formData: FormData) => createCampaignAction(formData, isDevner);
  const [state, action, pending] = useActionState(actionFn,
    undefined,
  );

  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  function onSenderChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const sender = senders.find((s) => s.id === e.target.value);
    if (!sender) return;
    setFromEmail(sender.email);
    setFromName(sender.name || "");
    setReplyTo(sender.replyTo || "");
  }

  return (
    <form action={action} className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div>
        <Label>Letter</Label>
        <Select name="letterId" required defaultValue="">
          <option value="" disabled>Choose a letter...</option>
          {letters.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </Select>
      </div>

      <div>
        <Label>Contact list</Label>
        <Select name="listId" required defaultValue="" disabled={!lists.length}>
          <option value="" disabled>{lists.length ? "Choose a list..." : "No lists yet - upload contacts first"}</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
          ))}
        </Select>
      </div>

      {!isDevner && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
          <div className="mb-3">
            <Label>From address</Label>
            <Select name="senderId" defaultValue="" onChange={onSenderChange}>
              <option value="">Custom (type below)...</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ? `${s.name} - ` : ""}{s.email}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>From email</Label>
              <input name="fromEmail" type="email" required value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder={`admin@${domain}`} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-cyan-500 focus:outline-none" />
            </div>
            <div>
              <Label>From name</Label>
              <input name="fromName" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Sales team" className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-cyan-500 focus:outline-none" />
            </div>
          </div>
          <div className="mt-3">
            <Label>Reply-to</Label>
            <input name="replyTo" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={`replies@${domain}`} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-cyan-500 focus:outline-none" />
          </div>
          <p className="mt-2 text-xs text-zinc-600">All from and reply-to addresses must use your domain ({domain}).</p>
        </div>
      )}

      {isDevner && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
          <p className="text-sm text-zinc-400">Devner mode handles sender addresses automatically - no from address selection needed.</p>
        </div>
      )}

      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <Button type="submit" disabled={pending || !letters.length || !lists.length}>
        {pending ? "Starting..." : "Start sending"}
      </Button>
    </form>
  );
}
