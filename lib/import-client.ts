import { parseContactsCsv, parseEmailsTxt, type ParsedContact } from "@/lib/csv";

export type ParsedImport = {
  contacts: ParsedContact[];
  errors: string[];
  skipped: number;
};

// Parses selected files in the browser. This intentionally happens before the
// first API call: Vercel caps serverless request bodies at ~4.5 MB, so the
// server never sees the original file. The client sends the resulting contacts
// in small JSON batches instead.
export async function parseImportFiles(files: File[]): Promise<ParsedImport> {
  const seen = new Set<string>();
  const contacts: ParsedContact[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const file of files) {
    let text: string;
    try {
      text = await file.text();
    } catch {
      errors.push(`${file.name}: could not be read and was skipped.`);
      continue;
    }

    const parsed = file.name.toLowerCase().endsWith(".txt")
      ? parseEmailsTxt(text)
      : parseContactsCsv(text);
    skipped += parsed.skipped;
    errors.push(...parsed.errors);

    for (const contact of parsed.contacts) {
      if (seen.has(contact.email)) {
        skipped++;
        continue;
      }
      seen.add(contact.email);
      contacts.push(contact);
    }
  }

  return { contacts, errors: errors.slice(0, 25), skipped };
}
