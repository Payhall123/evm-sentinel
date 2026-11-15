"use client";

import { useActionState, useState } from "react";
import { loginAdminAction, loginUserAction } from "@/app/actions/auth";
import { Button, Input, Label } from "@/components/ui";
import { cn } from "@/components/ui";

export default function LoginPage() {
  const [mode, setMode] = useState<"admin" | "user">("user");
  const [adminState, adminAction, adminPending] = useActionState(loginAdminAction, undefined);
  const [userState, userAction, userPending] = useActionState(loginUserAction, undefined);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            EVM<span className="text-cyan-400">Sentinel</span>
          </h1>
        </div>

        <div className="mb-6 grid grid-cols-2 rounded-xl bg-zinc-900 p-1 text-sm font-medium">
          {(["user", "admin"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-lg px-3 py-2 transition-colors",
                mode === m ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white",
              )}
            >
              {m === "user" ? "Account" : "Admin"}
            </button>
          ))}
        </div>

        {mode === "admin" ? (
          <form action={adminAction} className="space-y-4">
            <div>
              <Label>Email</Label>
              <Input name="email" type="email" required autoComplete="email" />
            </div>
            <div>
              <Label>Password</Label>
              <Input name="password" type="password" required />
            </div>
            {adminState?.error && <p className="text-sm text-red-400">{adminState.error}</p>}
            <Button type="submit" disabled={adminPending} className="w-full">
              Sign in
            </Button>
          </form>
        ) : (
          <form action={userAction} className="space-y-4">
            <div>
              <Label>Email</Label>
              <Input name="email" type="email" required autoComplete="email" />
            </div>
            <div>
              <Label>Access key</Label>
              <Input name="key" required autoComplete="off" placeholder="evm_..." />
            </div>
            {userState?.error && <p className="text-sm text-red-400">{userState.error}</p>}
            <Button type="submit" disabled={userPending} className="w-full">
              Sign in
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}