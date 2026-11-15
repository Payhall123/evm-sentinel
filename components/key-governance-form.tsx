"use client";

import { useActionState } from "react";
import { updateAccessKeyGovernanceAction, type AccessKeyFormState } from "@/app/actions/admin";
import { Button, Input, Label } from "@/components/ui";

function toLocalInput(d: Date | null | undefined): string {
  if (!d) return "";
  const copy = new Date(d);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 16);
}

type Props = {
  accessKeyId: string;
  dailyLimit: number | null;
  expiresAt: Date | null;
};

export function KeyGovernanceForm({ accessKeyId, dailyLimit, expiresAt }: Props) {
  const [state, action, pending] = useActionState(updateAccessKeyGovernanceAction, undefined);
  return (
    <form action={action} className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <input type="hidden" name="accessKeyId" value={accessKeyId} />
      <p className="mb-2 text-xs font-medium text-zinc-500">Daily limit &amp; expiry</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor={`limit-${accessKeyId}`} className="text-xs text-zinc-500">Daily limit</Label>
          <Input
            id={`limit-${accessKeyId}`}
            name="dailyLimit"
            type="number"
            min={0}
            max={10000000}
            step={1}
            defaultValue={dailyLimit ?? ""}
            placeholder="Unlimited"
          />
        </div>
        <div>
          <Label htmlFor={`exp-${accessKeyId}`} className="text-xs text-zinc-500">Expires at</Label>
          <Input
            id={`exp-${accessKeyId}`}
            name="expiresAt"
            type="datetime-local"
            defaultValue={expiresAt ? toLocalInput(expiresAt) : ""}
            placeholder="Never"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-zinc-600">
          Daily cap resets at UTC midnight · empty = unlimited / never expires
        </span>
        <Button type="submit" disabled={pending} className="rounded-lg bg-cyan-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {state?.error && <p className="mt-2 text-xs text-red-400">{state.error}</p>}
    </form>
  );
}
