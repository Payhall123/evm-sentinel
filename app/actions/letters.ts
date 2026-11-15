"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { optimizeLetterForDelivery } from "@/lib/grok-optimizer";
import { letterSchema, senderSchema } from "@/lib/validation";

export type LetterFormState = { error?: string };

function bodyForFormat(
  bodyFormat: "html" | "text",
  body: { htmlBody: string; plainText: string | null },
): { htmlBody: string; plainText: string | null } {
  return bodyFormat === "text"
    ? { htmlBody: "", plainText: body.plainText ?? null }
    : { htmlBody: body.htmlBody, plainText: null };
}

export async function createLetterAction(_prev: LetterFormState | undefined, formData: FormData): Promise<LetterFormState> {
  const { accessKey } = await requireUser();
  const parsed = letterSchema.safeParse({
    name: formData.get("name"),
    subject: formData.get("subject"),
    bodyFormat: formData.get("bodyFormat") ?? "html",
    htmlBody: formData.get("htmlBody") ?? "",
    plainText: formData.get("plainText") || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid input" };

  const optimized = await optimizeLetterForDelivery({
    name: parsed.data.name,
    subject: parsed.data.subject,
    bodyFormat: parsed.data.bodyFormat,
    htmlBody: parsed.data.htmlBody,
    plainText: parsed.data.plainText ?? null,
  });

  const letter = await prisma.letter.create({
    data: {
      name: parsed.data.name,
      subject: optimized.subject,
      ...bodyForFormat(parsed.data.bodyFormat, optimized),
      accessKeyId: accessKey.id,
    },
  });
  revalidatePath("/dashboard/letters");
  redirect(`/dashboard/letters/${letter.id}/edit`);
}

export async function updateLetterAction(letterId: string, _prev: LetterFormState | undefined, formData: FormData): Promise<LetterFormState> {
  const { accessKey } = await requireUser();
  const letter = await prisma.letter.findFirst({ where: { id: letterId, accessKeyId: accessKey.id } });
  if (!letter) return { error: "Letter not found" };

  const parsed = letterSchema.safeParse({
    name: formData.get("name"),
    subject: formData.get("subject"),
    bodyFormat: formData.get("bodyFormat") ?? "html",
    htmlBody: formData.get("htmlBody") ?? "",
    plainText: formData.get("plainText") || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid input" };

  const optimized = await optimizeLetterForDelivery({
    name: parsed.data.name,
    subject: parsed.data.subject,
    bodyFormat: parsed.data.bodyFormat,
    htmlBody: parsed.data.htmlBody,
    plainText: parsed.data.plainText ?? null,
  });

  await prisma.letter.update({
    where: { id: letterId },
    data: {
      name: parsed.data.name,
      subject: optimized.subject,
      ...bodyForFormat(parsed.data.bodyFormat, optimized),
    },
  });
  revalidatePath("/dashboard/letters");
  redirect("/dashboard/letters");
}

export async function deleteLetterAction(letterId: string): Promise<void> {
  const { accessKey } = await requireUser();
  await prisma.letter.deleteMany({ where: { id: letterId, accessKeyId: accessKey.id } });
  revalidatePath("/dashboard/letters");
}

export async function createSenderAction(_prev: LetterFormState | undefined, formData: FormData): Promise<LetterFormState> {
  const { accessKey } = await requireUser();
  const parsed = senderSchema.safeParse({
    email: formData.get("email"),
    name: formData.get("name") || null,
    replyTo: formData.get("replyTo") || null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || "Invalid input" };
  if (!parsed.data.email.toLowerCase().endsWith(`@${accessKey.domain}`)) {
    return { error: `From email must be on the configured domain (${accessKey.domain})` };
  }
  await prisma.sender.create({ data: { ...parsed.data, accessKeyId: accessKey.id } });
  revalidatePath("/dashboard/senders");
  return {};
}

export async function deleteSenderAction(senderId: string): Promise<void> {
  const { accessKey } = await requireUser();
  await prisma.sender.deleteMany({ where: { id: senderId, accessKeyId: accessKey.id } });
  revalidatePath("/dashboard/senders");
}
