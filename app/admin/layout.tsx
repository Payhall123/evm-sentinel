import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";
import { NavLink } from "@/components/nav-link";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40 p-4">
        <Link href="/admin" className="mb-6 block px-3 text-lg font-bold text-white">
          EVM<span className="text-cyan-400">Sentinel</span>{" "}
          <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">Admin</span>
        </Link>
        <nav className="flex flex-1 flex-col gap-1">
          <NavLink href="/admin" active>Overview</NavLink>
          <NavLink href="/admin/keys">Access keys</NavLink>
        </nav>
        <div className="border-t border-zinc-800 pt-3">
          <p className="px-3 pb-2 text-xs text-zinc-500">{admin.email}</p>
          <form action={logoutAction}>
            <button className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-400 hover:bg-zinc-800 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}