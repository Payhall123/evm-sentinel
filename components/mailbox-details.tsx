"use client";

import { useState } from "react";

type Props = {
  mailbox: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  label?: string;
};

export function MailboxDetails({ mailbox, host, port, username, password, label = "SMTP mailbox" }: Props) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyPassword() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="mt-3 rounded-lg bg-zinc-950 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-zinc-300">{label}</p>
        {password && (
          <div className="flex gap-3">
            <button type="button" onClick={() => setShow((s) => !s)} className="text-cyan-400 hover:underline">
              {show ? "Hide password" : "Reveal password"}
            </button>
            <button type="button" onClick={copyPassword} className="text-cyan-400 hover:underline">
              {copied ? "Copied!" : "Copy password"}
            </button>
          </div>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-600">Mailbox</dt>
        <dd className="break-all text-zinc-300">{mailbox}</dd>
        <dt className="text-zinc-600">Server</dt>
        <dd className="text-zinc-300">{host}</dd>
        <dt className="text-zinc-600">Port</dt>
        <dd className="text-zinc-300">{port} ({port === 465 ? "TLS" : "STARTTLS"})</dd>
        {username && (
          <>
            <dt className="text-zinc-600">Username</dt>
            <dd className="break-all text-zinc-300">{username}</dd>
          </>
        )}
        <dt className="text-zinc-600">Password</dt>
        <dd className="break-all text-zinc-300 select-all">{show && password ? password : "••••••••••••"}</dd>
      </dl>
    </div>
  );
}
