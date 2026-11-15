"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { cn } from "@/components/ui";

export function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const isActive = useMemo(() => {
    // An explicit override wins when provided (e.g. the admin overview link).
    if (active !== undefined) return active;
    // Section roots ("/dashboard", "/admin") should only highlight on an exact
    // match, otherwise they would also match every nested sub-route.
    if (href === "/dashboard" || href === "/admin") return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }, [active, href, pathname]);

  const className = useMemo(
    () =>
      cn(
        "group flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ease-in-out",
        isActive
          ? "bg-zinc-800/50 text-white group-hover:bg-zinc-800/70"
          : "text-zinc-400 hover:bg-zinc-800/10 hover:text-white group-hover:text-white",
      ),
    [isActive],
  );

  return (
    <Link href={href} className={className}>
      <div className="flex items-center w-full">{children}</div>
    </Link>
  );
}
