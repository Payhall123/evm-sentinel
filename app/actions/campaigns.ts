"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import type { Sender } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { campaignSchema } from "@/lib/validation";
import { ensureDispatcherRunning } from "@/lib/dispatcher";
import { kickDispatcher } from "@/lib/dispatch-kick";

export async function createCampaignAction(formData: FormData, isDevnerMode: boolean = false): Promise<{ error?: string }> {
  const { accessKey } = await requireUser();
  if (accessKey.status !== "active" && accessKey.status !== "dns_pending") {
    return { error: "Your access key is not active. Contact support." };
  }

  const parsed = campaignSchema.safeParse({
    letterId: formData.get("letterId"),
    listId: formData.get("listId"),
    senderId: formData.get("senderId") || undefined,
    fromEmail: formData.get("fromEmail") || undefined,
    fromName: formData.get("fromName") || undefined,
    replyTo: formData.get("replyTo") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid input" };

  let fromEmail: string;
  let fromName: string | null = null;
  let replyTo: string | null = null;
  let sender: Sender | null = null;

  if (isDevnerMode) {
    // Devner assigns the sender itself: it rotates across the mailboxes
    // connected to the account, so no from address is collected or stored.
    fromEmail = "";
    fromName = parsed.data.fromName || null;
    replyTo = parsed.data.replyTo || null;
    sender = null;
  } else {
    if (!parsed.data.fromEmail) {
      return { error: "From email is required" };
    }
    if (!parsed.data.fromEmail.toLowerCase().endsWith(`@${accessKey.domain}`)) {
      return { error: `From email must be on your domain (${accessKey.domain})` };
    }
    if (parsed.data.replyTo && !parsed.data.replyTo.toLowerCase().endsWith(`@${accessKey.domain}`)) {
      return { error: "Reply-to must be on your domain" };
    }

    sender = parsed.data.senderId
      ? await prisma.sender.findFirst({ where: { id: parsed.data.senderId, accessKeyId: accessKey.id } })
      : null;

    fromEmail = parsed.data.fromEmail;
    fromName = parsed.data.fromName || sender?.name || null;
    replyTo = parsed.data.replyTo || sender?.replyTo || null;
  }

  const [letter, list] = await Promise.all([
    prisma.letter.findFirst({ where: { id: parsed.data.letterId, accessKeyId: accessKey.id } }),
    prisma.contactList.findFirst({
      where: { id: parsed.data.listId, accessKeyId: accessKey.id },
      include: { _count: { select: { contacts: true } } },
    }),
  ]);
  if (!letter) return { error: "Letter not found" };
  if (!list) return { error: "Contact list not found" };
  if (!list._count.contacts) return { error: "That contact list is empty" };

  const contacts = await prisma.contact.findMany({ where: { listId: list.id }, select: { id: true, email: true } });

  // Create the campaign and all of its recipient rows in a single transaction.
  // The background dispatcher picks up "queued" campaigns on every tick, so if
  // the campaign row became visible before its messages existed it would see an
  // empty campaign and immediately mark it finished (failed) — which is exactly
  // what stalled a large send. Keeping the two writes atomic hides the campaign
  // from the dispatcher until every message row is committed. The long timeout
  // covers very large lists (tens of thousands of recipients).
  const campaign = await prisma.$transaction(
    async (tx) => {
      const created = await tx.campaign.create({
        data: {
          accessKeyId: accessKey.id,
          letterId: letter.id,
          listId: list.id,
          senderId: sender?.id || null,
          fromEmail,
          fromName,
          replyTo,
          subject: letter.subject,
          status: "queued",
          totalCount: list._count.contacts,
        },
      });
      await tx.message.createMany({
        data: contacts.map((c) => ({
          campaignId: created.id,
          contactId: c.id,
          email: c.email,
          fromEmail,
        })),
      });
      return created;
    },
    { timeout: 300_000, maxWait: 30_000 },
  );

  // Start sending immediately instead of waiting for the scheduler. On Vercel
  // there is no process to hold the local interval, so the tick is queued to
  // run after this action's redirect has been sent; locally the interval is
  // started as before.
  if (process.env.VERCEL) {
    after(() => kickDispatcher({ timeBudgetMs: 20_000, minIntervalMs: 0 }));
  } else {
    ensureDispatcherRunning();
  }
  revalidatePath("/dashboard/campaigns");
  redirect(`/dashboard/campaigns/${campaign.id}`);
}

export async function pauseCampaignAction(campaignId: string): Promise<{ ok: boolean }> {
  const { accessKey } = await requireUser();
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, accessKeyId: accessKey.id } });
  if (!campaign) return { ok: false };
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: campaign.status === "paused" ? "queued" : "paused" } });
  revalidatePath("/dashboard/campaigns");
  return { ok: true };
}

export async function removeCampaignAction(campaignId: string): Promise<void> {
  const { accessKey } = await requireUser();
  await prisma.campaign.deleteMany({ where: { id: campaignId, accessKeyId: accessKey.id } });
  revalidatePath("/dashboard/campaigns");
}
