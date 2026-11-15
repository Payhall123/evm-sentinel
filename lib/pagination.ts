export const PAGE_SIZE = 50;

export function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export function pageCountFor(total: number, pageSize = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageFromParam(value: string | string[] | undefined, pageCount: number): number {
  const parsed = Number.parseInt(firstParam(value), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(1, parsed), Math.max(1, pageCount));
}
