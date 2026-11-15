import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { CampaignDetail } from "@/components/campaign-detail";
import { deliveryCountsForCampaign } from "@/lib/analytics";
import { normalizeDeliveryFilter } from "@/lib/campaign-filters";
import { PAGE_SIZE, firstParam, pageCountFor, pageFromParam } from "@/lib/pagination";

export const dynamic = "force-dynamic";

function messageWhere(campaignId: string, query: string, deliveryFilter: string): Prisma.MessageWhereInput {
  const conditions: Prisma.MessageWhereInput[] = [];

  if (query) {
    conditions.push({
      OR: [
        { email: { contains: query, mode: "insensitive" } },
        { contact: { is: { firstName: { contains: query, mode: "insensitive" } } } },
        { contact: { is: { lastName: { contains: query, mode: "insensitive" } } } },
      ],
    });
  }

  if (deliveryFilter === "pending") {
    conditions.push({ status: "sent", deliveryStatus: null });
  } else if (deliveryFilter) {
    conditions.push({ deliveryStatus: deliveryFilter });
  }

  return conditions.length ? { campaignId, AND: conditions } : { campaignId };
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { accessKey } = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const query = firstParam(sp.q).trim().slice(0, 200);
  const deliveryFilter = normalizeDeliveryFilter(firstParam(sp.delivery));

  const campaign = await prisma.campaign.findFirst({
    where: { id, accessKeyId: accessKey.id },
    include: { letter: { select: { name: true } }, list: { select: { name: true } } },
  });
  if (!campaign) notFound();

  const where = messageWhere(id, query, deliveryFilter);
  const [messageTotal, delivery] = await Promise.all([
    prisma.message.count({ where }),
    deliveryCountsForCampaign(id),
  ]);
  const pageCount = pageCountFor(messageTotal);
  const page = pageFromParam(sp.page, pageCount);
  const messages = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: { contact: true },
  });

  return (
    <CampaignDetail
      campaign={{
        id: campaign.id,
        status: campaign.status,
        totalCount: campaign.totalCount,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
        fromEmail: campaign.fromEmail,
        fromName: campaign.fromName,
        replyTo: campaign.replyTo,
        subject: campaign.subject,
        error: campaign.error,
        letter: campaign.letter,
        list: campaign.list,
      }}
      delivery={delivery}
      messages={messages.map((m) => ({
        id: m.id,
        email: m.email,
        status: m.status,
        deliveryStatus: m.deliveryStatus,
        deliveryDetail: m.deliveryDetail,
        sentAt: m.sentAt ? m.sentAt.toISOString() : null,
        contact: m.contact,
      }))}
      messageTotal={messageTotal}
      page={page}
      pageCount={pageCount}
      query={query}
      deliveryFilter={deliveryFilter}
    />
  );
}
