"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setupCloudflareInboundAction } from "@/app/actions/admin";
import { Button, Input, Label } from "@/components/ui";

type Props = {
  accessKeyId: string;
  domain: string;
};

// Shown on an outbound-only Cloudflare key. Creating an inbound address is a
// second, optional call to Cloudflare Email Routing; the outbound REST send
// transport is already working.
export function CloudflareInboundForm({ accessKeyId, domain }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inbox, setInbox] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNote(null);
    startTransition(async () => {
      try {
        const result = await setupCloudflareInboundAction(accessKeyId, {
          inboxAddress: inbox,
          forwardTo,
          zoneId: zoneId.trim() || undefined,
        });
        if (!result.ok) {
          setError(result.error || "Could not set up inbound mail.");
          return;
        }
        setNote(
          result.status === "active"
            ? "Inbound routing is active."
            : result.note || "Cloudflare needs the destination address verified before routing starts.",
        );
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not set up inbound mail.");
      }
    });
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg bg-zinc-950 p-3 text-xs">
      <div>
        <p className="text-sm font-medium text-zinc-300">Receive mail (optional)</p>
        <p className="mt-1 text-xs text-zinc-500">
          Creates a Cloudflare Email Routing rule. No SMTP mailbox is hosted here; mail is forwarded to the
          destination inbox.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>Inbox address</Label>
          <Input
            value={inbox}
            onChange={(e) => setInbox(e.target.value)}
            placeholder={`hello (or hello@${domain})`}
            autoComplete="off"
            required
          />
        </div>
        <div>
          <Label>Forward to</Label>
          <Input
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
            type="email"
            placeholder="owner@gmail.com"
            autoComplete="off"
            required
          />
        </div>
      </div>
      <div>
        <Label>Zone ID (optional)</Label>
        <Input
          value={zoneId}
          onChange={(e) => setZoneId(e.target.value)}
          placeholder="Auto-detected from the domain"
          autoComplete="off"
        />
      </div>
      {error && <p className="text-red-300">{error}</p>}
      {note && <p className="text-amber-300">{note}</p>}
      <Button type="submit" disabled={pending}>
        {pending ? "Setting up inbound…" : "Set up inbound mail"}
      </Button>
    </form>
  );
}
