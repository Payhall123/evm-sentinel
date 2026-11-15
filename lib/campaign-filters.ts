export const DELIVERY_FILTERS = [
  { value: "", label: "All delivery outcomes" },
  { value: "sent", label: "Delivered (inboxed)" },
  { value: "pending", label: "Accepted / pending" },
  { value: "soft_fail", label: "Soft-failed" },
  { value: "hard_fail", label: "Hard-failed" },
  { value: "bounced", label: "Bounced" },
  { value: "held", label: "Held" },
] as const;

export type DeliveryFilter = (typeof DELIVERY_FILTERS)[number]["value"];

const DELIVERY_FILTER_VALUES = new Set<string>(DELIVERY_FILTERS.map((f) => f.value));

export function normalizeDeliveryFilter(value: string): DeliveryFilter {
  return DELIVERY_FILTER_VALUES.has(value) ? (value as DeliveryFilter) : "";
}
