import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import ImportCsvForm from "@/components/import-csv-form";

export const dynamic = "force-dynamic";

export default async function UploadContactsPage() {
  const { accessKey } = await requireUser();
  const lists = await prisma.contactList.findMany({
    where: { accessKeyId: accessKey.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-semibold text-white">Upload contacts</h1>
      <ImportCsvForm lists={lists} />
    </div>
  );
}