"use client";

import { useActionState } from "react";
import { createSenderAction } from "@/app/actions/letters";
import { Button, Input, Label } from "@/components/ui";

export function SenderForm({ domain }: { domain: string }) {
  const [state, action, pending] = useActionState(createSenderAction, undefined);
  return (
    <form action={action} className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 h-fit">
      <h2 className="text-base font-medium text-white">Add a from address</h2>
      <div>
        <Label>Display name (optional)</Label>
        <Input name="name" placeholder="Acme Sales" />
      </div>
      <div>
        <Label>From email</Label>
        <Input name="email" type="email" required placeholder={`sales@${domain}`} />
      </div>
      <div>
        <Label>Reply-to (optional)</Label>
        <Input name="replyTo" type="email" placeholder={`replies@${domain}`} />
      </div>
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add address"}</Button>
    </form>
  );
}