import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EditLetterForm } from "@/components/letter-form";

export const dynamic = "force-dynamic";

export default async function EditLetterPage({ params }: { params: Promise<{ id: string }> }) {
  const { accessKey } = await requireUser();
  const { id } = await params;
  const letter = await prisma.letter.findFirst({ where: { id, accessKeyId: accessKey.id } });
  if (!letter) notFound();

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold text-white">Edit letter</h1>
      <EditLetterForm letter={letter} />
    </div>
  );
}