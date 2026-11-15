"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

async function ensureOwnList(listId: string) {
  const { accessKey } = await requireUser();
  const list = await prisma.contactList.findFirst({ where: { id: listId, accessKeyId: accessKey.id } });
  if (!list) throw new Error("List not found");
  return list;
}

export type CreateListResult = { error?: string };

export async function createListAction(_prev: unknown, formData: FormData): Promise<CreateListResult> {
  const { accessKey } = await requireUser();
  const name = String(formData.get("name") || "").trim();
  if (!name) return { error: "List name is required" };
  const data = { name, accessKeyId: accessKey.id };
  await prisma.contactList.create({ data });
  revalidatePath("/dashboard/contacts");
  revalidatePath("/dashboard/contacts/upload");
  return {};
}

export async function deleteListAction(listId: string): Promise<void> {
  await ensureOwnList(listId);
  await prisma.contactList.delete({ where: { id: listId } });
  revalidatePath("/dashboard/contacts");
}