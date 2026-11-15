"use client";

import { useState } from "react";
import { useActionState } from "react";
import { createLetterAction, updateLetterAction } from "@/app/actions/letters";
import { Button, Input, Label, Textarea, cn } from "@/components/ui";

type LetterFormat = "html" | "text";

function FormatSwitcher({ value, onChange }: { value: LetterFormat; onChange: (value: LetterFormat) => void }) {
  return (
    <div>
      <Label>Body format</Label>
      <div
        role="group"
        aria-label="Letter body format"
        className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-1"
      >
        <button
          type="button"
          aria-pressed={value === "html"}
          onClick={() => onChange("html")}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400",
            value === "html" ? "bg-cyan-600 text-white" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          HTML
        </button>
        <button
          type="button"
          aria-pressed={value === "text"}
          onClick={() => onChange("text")}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400",
            value === "text" ? "bg-cyan-600 text-white" : "text-zinc-400 hover:text-zinc-200",
          )}
        >
          Plain text
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {value === "html"
          ? "The letter is sent as an HTML email."
          : "The letter is sent as plain text. Line breaks are preserved and no HTML is generated."}
      </p>
    </div>
  );
}

function LetterBodyEditor({
  format,
  htmlBody,
  plainText,
  onHtmlBodyChange,
  onPlainTextChange,
  rows,
}: {
  format: LetterFormat;
  htmlBody: string;
  plainText: string;
  onHtmlBodyChange: (value: string) => void;
  onPlainTextChange: (value: string) => void;
  rows: number;
}) {
  if (format === "text") {
    return (
      <div>
        <Label htmlFor="plainText">Plain-text body</Label>
        <Textarea
          id="plainText"
          name="plainText"
          rows={rows}
          value={plainText}
          onChange={(e) => onPlainTextChange(e.target.value)}
          placeholder={"Hello {firstName},\n\nI wanted to reach out about..."}
        />
        <p className="mt-1 text-xs text-zinc-600">
          Sent as text/plain only. Use placeholders {"{firstName}"}, {"{lastName}"}, {"{email}"} — they&apos;ll be
          filled per recipient.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label htmlFor="htmlBody">HTML body</Label>
      <Textarea
        id="htmlBody"
        name="htmlBody"
        rows={rows}
        value={htmlBody}
        onChange={(e) => onHtmlBodyChange(e.target.value)}
        placeholder="<p>Hello {firstName},</p><p>...</p>"
      />
      <p className="mt-1 text-xs text-zinc-600">
        Sent as text/html. Use placeholders {"{firstName}"}, {"{lastName}"}, {"{email}"} — they&apos;ll be filled per
        recipient.
      </p>
    </div>
  );
}

function formatForLetter(letter: { htmlBody: string; plainText: string | null }): LetterFormat {
  if (letter.htmlBody.trim()) return "html";
  if (letter.plainText?.trim()) return "text";
  return "html";
}

export function LetterForm() {
  const [state, action, pending] = useActionState(createLetterAction, undefined);
  const [format, setFormat] = useState<LetterFormat>("html");
  const [htmlBody, setHtmlBody] = useState("");
  const [plainText, setPlainText] = useState("");

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="bodyFormat" value={format} />
      <FormatSwitcher value={format} onChange={setFormat} />
      <div>
        <Label>Letter name</Label>
        <Input name="name" required placeholder="Q3 outreach" />
      </div>
      <div>
        <Label>Subject</Label>
        <Input name="subject" required placeholder="Quick question" />
      </div>
      <LetterBodyEditor
        format={format}
        htmlBody={htmlBody}
        plainText={plainText}
        onHtmlBodyChange={setHtmlBody}
        onPlainTextChange={setPlainText}
        rows={10}
      />
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <div className="flex items-center justify-between">
        <Button type="submit" disabled={pending}>
          {pending ? "Optimizing & saving…" : "Save letter"}
        </Button>
        {!pending && state && !state.error && (
          <p className="text-sm text-green-400">Letter saved successfully</p>
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Saving includes AI optimization of the selected format for better email deliverability (may take a few seconds)
      </p>
    </form>
  );
}

export function EditLetterForm({ letter }: { letter: { id: string; name: string; subject: string; htmlBody: string; plainText: string | null } }) {
  const [state, action, pending] = useActionState(updateLetterAction.bind(null, letter.id), undefined);
  const [format, setFormat] = useState<LetterFormat>(formatForLetter(letter));
  const [htmlBody, setHtmlBody] = useState(letter.htmlBody);
  const [plainText, setPlainText] = useState(letter.plainText || "");

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="bodyFormat" value={format} />
      <FormatSwitcher value={format} onChange={setFormat} />
      {letter.htmlBody.trim() && letter.plainText?.trim() && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          This letter has both an HTML body and a plain-text body. Choose the format above; saving keeps only the
          selected body.
        </p>
      )}
      <div>
        <Label>Letter name</Label>
        <Input name="name" required defaultValue={letter.name} />
      </div>
      <div>
        <Label>Subject</Label>
        <Input name="subject" required defaultValue={letter.subject} />
      </div>
      <LetterBodyEditor
        format={format}
        htmlBody={htmlBody}
        plainText={plainText}
        onHtmlBodyChange={setHtmlBody}
        onPlainTextChange={setPlainText}
        rows={12}
      />
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <div className="flex items-center justify-between">
        <Button type="submit" disabled={pending}>
          {pending ? "Optimizing & saving…" : "Save changes"}
        </Button>
        {!pending && state && !state.error && (
          <p className="text-sm text-green-400">Changes saved successfully</p>
        )}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Saving includes AI optimization of the selected format for better email deliverability (may take a few seconds)
      </p>
    </form>
  );
}
