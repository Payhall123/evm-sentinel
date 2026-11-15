import Link from "next/link";
import { Badge, Button, Card, Input, Select, type Tone } from "@/components/ui";
import { Pagination } from "@/components/pagination";
import { CampaignAutoRefresh } from "@/components/campaign-auto-refresh";
import { DELIVERY_FILTERS, type DeliveryFilter } from "@/lib/campaign-filters";
import { PAGE_SIZE } from "@/lib/pagination";

type Campaign = {
  id: string;
  status: string;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  fromEmail: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  error?: string | null;
  letter: { name: string } | null;
  list: { name: string } | null;
};

type Delivery = {
  total: number;
  queued: number;
  accepted: number;
  failed: number;
  skipped: number;
  delivered: number;
  softFail: number;
  hardFail: number;
  bounced: number;
  held: number;
  pending: number;
};

type Message = {
  id: string;
  email: string;
  status: string;
  deliveryStatus?: string | null;
  deliveryDetail?: string | null;
  sentAt: string | null;
  contact: { firstName?: string | null } | null;
};

const DONE = new Set(["sent", "failed", "partial"]);

// Transport-reported outcomes, in the order they matter for deliverability.
const DELIVERY_FIELDS: { key: keyof Delivery; label: string; tone: Tone; filter: DeliveryFilter }[] = [
  { key: "delivered", label: "Delivered", tone: "green", filter: "sent" },
  { key: "softFail", label: "Soft-failed", tone: "amber", filter: "soft_fail" },
  { key: "hardFail", label: "Hard-failed", tone: "red", filter: "hard_fail" },
  { key: "bounced", label: "Bounced", tone: "red", filter: "bounced" },
  { key: "held", label: "Held", tone: "cyan", filter: "held" },
  { key: "pending", label: "Pending", tone: "zinc", filter: "pending" },
];

const TONE_TEXT: Record<Tone, string> = {
  green: "text-emerald-400",
  amber: "text-amber-400",
  red: "text-red-400",
  cyan: "text-cyan-400",
  zinc: "text-zinc-300",
};

const DELIVERY_TONE: Record<string, Tone> = {
  sent: "green",
  soft_fail: "amber",
  hard_fail: "red",
  bounced: "red",
  held: "cyan",
};

const DELIVERY_LABEL: Record<string, string> = {
  sent: "Delivered",
  soft_fail: "Soft-failed",
  hard_fail: "Hard-failed",
  bounced: "Bounced",
  held: "Held",
};

export function CampaignDetail({
  campaign,
  delivery,
  messages,
  messageTotal,
  page,
  pageCount,
  query,
  deliveryFilter,
}: {
  campaign: Campaign;
  delivery: Delivery;
  messages: Message[];
  messageTotal: number;
  page: number;
  pageCount: number;
  query: string;
  deliveryFilter: DeliveryFilter;
}) {
  const hrefFor = (next: { page?: number; delivery?: DeliveryFilter } = {}) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    const nextDelivery = next.delivery === undefined ? deliveryFilter : next.delivery;
    if (nextDelivery) params.set("delivery", nextDelivery);
    const nextPage = next.page ?? 1;
    if (nextPage > 1) params.set("page", String(nextPage));
    const qs = params.toString();
    return `/dashboard/campaigns/${campaign.id}${qs ? `?${qs}` : ""}`;
  };

  const pct = campaign.totalCount
    ? Math.min(100, ((campaign.sentCount + campaign.failedCount) / campaign.totalCount) * 100)
    : 0;

  const toneFor = (s: string): Tone =>
    s === "sent" ? "green" : s === "failed" ? "red" : s === "partial" ? "amber" : "cyan";

  const reported = delivery.delivered + delivery.softFail + delivery.hardFail + delivery.bounced + delivery.held;
  const deliveryRate = reported > 0 ? Math.round((delivery.delivered / reported) * 100) : null;
  const start = messageTotal ? (page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(page * PAGE_SIZE, messageTotal);

  return (
    <div>
      <CampaignAutoRefresh status={campaign.status} />

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">{campaign.letter?.name}</h1>
          <p className="text-sm text-zinc-500">
            {campaign.list?.name} · {campaign.totalCount} recipients · from{" "}
            {campaign.fromEmail
              ? campaign.fromName
                ? `${campaign.fromName} <${campaign.fromEmail}>`
                : campaign.fromEmail
              : "auto-selected sender"}
            {campaign.replyTo ? ` · reply-to ${campaign.replyTo}` : ""}
          </p>
        </div>
        <Badge tone={toneFor(campaign.status)}>{campaign.status}</Badge>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="text-center">
          <p className="text-3xl font-semibold text-white">{campaign.totalCount}</p>
          <p className="mt-1 text-sm text-zinc-500">Total</p>
        </Card>
        <Card className="text-center">
          <p className="text-3xl font-semibold text-cyan-400">{delivery.accepted}</p>
          <p className="mt-1 text-sm text-zinc-500">Accepted</p>
        </Card>
        <Card className="text-center">
          <p className="text-3xl font-semibold text-red-400">{delivery.failed}</p>
          <p className="mt-1 text-sm text-zinc-500">Failed</p>
        </Card>
        <Card className="text-center">
          <p className="text-3xl font-semibold text-zinc-300">{delivery.skipped}</p>
          <p className="mt-1 text-sm text-zinc-500">Skipped</p>
        </Card>
      </div>

      <div className="mb-6 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-cyan-500 transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="mb-6">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Delivery outcomes</h2>
            <p className="mt-1 text-xs text-zinc-500">Click an outcome to filter the recipient list.</p>
          </div>
          <p className="text-xs text-zinc-500">
            {deliveryRate !== null ? `${deliveryRate}% delivered of ${reported} reported` : "awaiting reports from the mail server"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {DELIVERY_FIELDS.map((f) => (
            <Link
              key={f.key}
              href={hrefFor({ delivery: f.filter })}
              title={`Show ${f.label.toLowerCase()} recipients`}
              className="block rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            >
              <Card
                className={`h-full py-4 text-center transition-colors hover:border-cyan-500/50 ${
                  deliveryFilter === f.filter ? "border-cyan-500/60" : ""
                }`}
              >
                <p className={`text-2xl font-semibold ${TONE_TEXT[f.tone]}`}>{delivery[f.key]}</p>
                <p className="mt-1 text-xs text-zinc-500">{f.label}</p>
              </Card>
            </Link>
          ))}
        </div>
        {delivery.accepted > 0 && reported === 0 && (
          <p className="mt-2 text-xs text-zinc-500">
            The transport has not reported any delivery outcomes for this send yet.
          </p>
        )}
      </div>

      {campaign.error && <p className="mb-4 text-sm text-red-400">Last error: {campaign.error}</p>}

      {!DONE.has(campaign.status) && (
        <p className="mb-4 text-sm text-cyan-400">
          Sending in progress — {delivery.queued} queued · updates every 2 seconds…
        </p>
      )}

      <form
        method="get"
        action={`/dashboard/campaigns/${campaign.id}`}
        className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center"
      >
        <Input
          key={query}
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search recipient email or name..."
          className="lg:max-w-sm"
        />
        <Select key={deliveryFilter} name="delivery" defaultValue={deliveryFilter} className="lg:max-w-56">
          {DELIVERY_FILTERS.map((f) => (
            <option key={f.value || "all"} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-3">
          <Button type="submit">Search</Button>
          {(query || deliveryFilter) && (
            <Link href={`/dashboard/campaigns/${campaign.id}`} className="text-sm text-zinc-400 hover:text-white">
              Clear
            </Link>
          )}
        </div>
      </form>

      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Recipients</h2>
        <p className="text-xs text-zinc-500">
          {query || deliveryFilter ? `${messageTotal.toLocaleString()} matching` : `${messageTotal.toLocaleString()} total`}
          {messageTotal > 0 ? ` · showing ${start.toLocaleString()}–${end.toLocaleString()}` : ""}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Delivery</th>
              <th className="px-4 py-3">Sent at</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {messages.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-2 text-zinc-200">
                  {m.contact?.firstName ? `${m.contact.firstName} · ` : ""}
                  {m.email}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={m.status === "sent" ? "green" : m.status === "failed" ? "red" : "zinc"}>{m.status}</Badge>
                </td>
                <td className="px-4 py-2">
                  {m.deliveryStatus ? (
                    <span title={m.deliveryDetail || undefined}>
                      <Badge tone={DELIVERY_TONE[m.deliveryStatus] ?? "zinc"}>
                        {DELIVERY_LABEL[m.deliveryStatus] ?? m.deliveryStatus}
                      </Badge>
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-zinc-500">{m.sentAt ? new Date(m.sentAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {!messages.length && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                  {query || deliveryFilter ? "No recipients match this search or filter." : "No messages yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} hrefForPage={(nextPage) => hrefFor({ page: nextPage })} />
    </div>
  );
}
