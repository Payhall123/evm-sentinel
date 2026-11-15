import { LetterForm } from "@/components/letter-form";

export default function NewLetterPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-semibold text-white">New letter</h1>
      <LetterForm />
    </div>
  );
}