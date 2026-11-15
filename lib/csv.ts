import Papa from "papaparse";

export type ParsedContact = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The parser runs in the browser for Vercel deployments, so it must stay
// isomorphic: no node-only imports and no server environment variables. The
// cap only guards against an unbounded or malformed file.
const DEFAULT_MAX_ROWS = 2_000_000;

export function parseContactsCsv(csv: string, maxRows = DEFAULT_MAX_ROWS): { contacts: ParsedContact[]; errors: string[]; skipped: number } {
  const errors: string[] = [];
  const parsed = Papa.parse<string[]>(csv.trim(), {
    skipEmptyLines: true,
    transform: (v: string) => v.trim(),
  });
  if (parsed.errors.length) {
    errors.push(...parsed.errors.map((e) => `Line ${(e.row ?? 0) + 1}: ${e.message}`).slice(0, 20));
  }
  if (!parsed.data.length) {
    errors.push("The CSV file is empty.");
    return { contacts: [], errors, skipped: 0 };
  }

  const headerRow = parsed.data[0].map((h) => h.toLowerCase().replace(/\s+/g, ""));
  const find = (aliases: string[]) => headerRow.findIndex((h) => aliases.includes(h));
  const emailIdx = find(["email", "e-mail", "mail", "emailaddress", "email address", "address"]);
  const firstIdx = find(["firstname", "first", "firstname", "first name", "firstName"]);
  const lastIdx = find(["lastname", "last", "lastname", "last name", "lastName", "surname"]);

  if (emailIdx < 0) {
    errors.push("Could not find an email column. Expected headers like 'email'.");
    return { contacts: [], errors, skipped: 0 };
  }

  const contacts: ParsedContact[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (let i = 1; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const email = (row[emailIdx] || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      skipped++;
      if (errors.length < 25) errors.push(`Row ${i + 1}: invalid email "${email}" skipped.`);
      continue;
    }
    if (seen.has(email)) {
      skipped++;
      continue;
    }
    seen.add(email);
    contacts.push({
      email,
      firstName: firstIdx >= 0 ? row[firstIdx] || null : null,
      lastName: lastIdx >= 0 ? row[lastIdx] || null : null,
    });
    if (contacts.length >= maxRows) {
      errors.push(`Stopped at ${maxRows} contacts (limit reached).`);
      break;
    }
  }

  return { contacts, errors, skipped };
}

// Parses a plain-text email list: one or more email addresses per line, separated
// by commas/semicolons. Handles both bare addresses and "Name <email>" format.
export function parseEmailsTxt(txt: string, maxRows = DEFAULT_MAX_ROWS): { contacts: ParsedContact[]; errors: string[]; skipped: number } {
  const errors: string[] = [];
  const contacts: ParsedContact[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const lines = txt.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const tokens = line.includes("<") ? [line.match(/<([^<>]+)>/)?.[1] || line] : line.split(/[,;]/).map((t) => t.trim()).filter(Boolean);

    for (const tok of tokens) {
      const email = tok.replace(/[<>]/g, "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        skipped++;
        if (tok.includes("@") && errors.length < 25) errors.push(`Line ${i + 1}: "${tok}" is not a valid email and was skipped.`);
        continue;
      }
      if (seen.has(email)) {
        skipped++;
        continue;
      }
      seen.add(email);
      contacts.push({ email, firstName: null, lastName: null });
      if (contacts.length >= maxRows) {
        errors.push(`Stopped at ${maxRows} contacts (limit reached).`);
        break;
      }
    }
    if (errors.length >= 25) {
      errors.push("More errors omitted.");
      break;
    }
  }

  if (!contacts.length && !errors.length) errors.push("No email addresses found in this file.");
  return { contacts, errors, skipped };
}