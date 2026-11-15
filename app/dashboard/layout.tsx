import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";
import { NavLink } from "@/components/nav-link";
import { SendToast } from "@/components/send-toast";
import { Badge } from "@/components/ui";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { accessKey } = await requireUser();

  const domainActive = accessKey.status === "active" || accessKey.status === "dns_pending";

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/50 backdrop-blur-sm p-4">
        <Link href="/dashboard" className="mb-2 block px-3 py-2 text-xl font-bold text-white">
          EVM<span className="text-cyan-400">Sentinel</span>
        </Link>
        <div className="mb-4 px-3">
          <p className="truncate text-xs text-zinc-400">{accessKey.name}</p>
          <Badge tone={domainActive ? "green" : "amber"}>{accessKey.domain}</Badge>
          <p className="mt-1 text-[10px] text-zinc-500">
            {accessKey.provider === "ses"
              ? "Amazon SES"
              : accessKey.provider === "elasticemail"
                ? "Elastic Email"
                : accessKey.provider === "resend"
                  ? "Resend"
                  : accessKey.provider === "mailgun"
                    ? "Mailgun"
                    : accessKey.provider === "cloudflare"
                      ? "Cloudflare Email"
                      : accessKey.provider === "zeptomail"
                        ? "ZeptoMail SMTP"
                        : accessKey.status === "active"
                          ? "Domain verified"
                          : accessKey.status === "dns_pending"
                            ? "Waiting on DNS"
                            : accessKey.status}
          </p>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          <NavLink href="/dashboard">Overview</NavLink>
          <NavLink href="/dashboard/letters">Letters</NavLink>
          <NavLink href="/dashboard/contacts">Contacts</NavLink>
          <NavLink href="/dashboard/senders">From addresses</NavLink>
          <NavLink href="/dashboard/campaigns">Campaigns</NavLink>
          <NavLink href="/dashboard/analytics">Analytics</NavLink>
          <NavLink href="/dashboard/smtp">SMTP settings</NavLink>
        </nav>
        <div className="border-t border-zinc-800 pt-4">
          <form action={logoutAction}>
            <button className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors duration-200">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-8 bg-zinc-950">{children}</main>
      <SendToast />
    </div>
  );
}
