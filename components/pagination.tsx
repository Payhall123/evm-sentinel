import Link from "next/link";
import { cn } from "@/components/ui";

function pageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set([1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) out.push("gap");
    out.push(page);
    previous = page;
  }
  return out;
}

export function Pagination({
  page,
  pageCount,
  hrefForPage,
}: {
  page: number;
  pageCount: number;
  hrefForPage: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  const linkClass =
    "inline-flex h-9 min-w-9 items-center justify-center rounded-lg border px-3 text-sm font-medium transition-colors";
  const inactive = "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800";
  const disabled = "border-zinc-800 bg-zinc-950 text-zinc-600";
  const active = "border-cyan-500 bg-cyan-500/15 text-cyan-300";

  return (
    <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
      {page > 1 ? (
        <Link href={hrefForPage(page - 1)} className={cn(linkClass, inactive)}>
          Previous
        </Link>
      ) : (
        <span className={cn(linkClass, disabled)}>Previous</span>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {pageWindow(page, pageCount).map((item, index) =>
          item === "gap" ? (
            <span key={`gap-${index}`} className="px-1 text-sm text-zinc-600">
              …
            </span>
          ) : (
            <Link
              key={item}
              href={hrefForPage(item)}
              aria-current={item === page ? "page" : undefined}
              className={cn(linkClass, item === page ? active : inactive)}
            >
              {item}
            </Link>
          ),
        )}
      </div>

      {page < pageCount ? (
        <Link href={hrefForPage(page + 1)} className={cn(linkClass, inactive)}>
          Next
        </Link>
      ) : (
        <span className={cn(linkClass, disabled)}>Next</span>
      )}
    </nav>
  );
}
