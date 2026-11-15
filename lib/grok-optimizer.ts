import "server-only";

// Groq API keys for letter optimization come only from the environment.
// Never commit live keys: secret scanning rejects the push, and a leaked key
// can be used against the account. Keys whose organisation is restricted/dead
// return HTTP 400 and are pruned at runtime (see deadKeys).
const GROQ_API_KEYS: string[] =
  process.env.GROQ_API_KEYS?.split(",")
    .map((k) => k.trim())
    .filter(Boolean) ?? [];

let keyIndex = 0;

// Keys confirmed dead (restricted organisation / revoked) are skipped from
// rotation for the lifetime of the process, so one bad fallback key can never
// stall optimization.
const deadKeys = new Set<string>();

// Model preference per key tier: actual Groq-hosted models first, generic
// fallbacks last. A model-related error advances this list so a
// missing/deprecated model never blocks optimization.
const GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-70b-versatile",
  "grok-4",
  "grok-3",
];

let modelIndex = 0;

// Configuration from environment variables with sensible defaults
const OPTIMIZATION_TIMEOUT_MS = Number(process.env.OPTIMIZATION_TIMEOUT_MS || 120_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60_000);
const MAX_RETRY_ATTEMPTS = Number(process.env.MAX_RETRY_ATTEMPTS || 6);

function getNextKey(): string {
  // Scan forward past keys already known to be dead; if they all are, fall
  // through to the rotation slot so the caller can surface the real error.
  for (let attempt = 0; attempt < GROQ_API_KEYS.length; attempt++) {
    const key = GROQ_API_KEYS[keyIndex % GROQ_API_KEYS.length];
    keyIndex = (keyIndex + 1) % GROQ_API_KEYS.length;
    if (!deadKeys.has(key)) return key;
  }
  return GROQ_API_KEYS[keyIndex % GROQ_API_KEYS.length];
}

function currentModel(): string {
  return GROQ_MODELS[modelIndex % GROQ_MODELS.length];
}

function advanceModel(): void {
  modelIndex = (modelIndex + 1) % GROQ_MODELS.length;
}

function isModelProblem(status: number | undefined, message: string): boolean {
  if (status === 404) return true;
  return status === 400 && /\bmodel\b/i.test(message);
}

// Credential-level failures (revoked/restricted key, wrong key on this tier)
// should rotate to the next key instead of aborting the whole optimization.
function isKeyProblem(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 400) {
    return /restricted|invalid.?api.?key|api key|organization|insufficient_quota/i.test(message);
  }
  return false;
}

export type LetterBodyFormat = "html" | "text";

export interface OptimizedLetter {
  subject: string;
  htmlBody: string;
  plainText: string | null;
}

function extractJson(text: string): unknown {
  let jsonContent = text.trim();
  const fenceMatch = jsonContent.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    jsonContent = fenceMatch[1];
  } else if (jsonContent.startsWith("```")) {
    jsonContent = jsonContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(jsonContent);
  } catch {
      // More robust JSON extraction - look for the first { and last }
      // and try to parse what's in between
      const start = jsonContent.indexOf("{");
      const end = jsonContent.lastIndexOf("}");
      if (start === -1 || end <= start || end + 1 >= jsonContent.length) {
        throw new Error(`Model did not return valid JSON object: ${text.slice(0, 200)}`);
      }
      const potentialJson = jsonContent.slice(start, end + 1);
      try {
        return JSON.parse(potentialJson);
      } catch (innerError) {
        // If that fails, try to find any valid JSON object in the text
        // by looking for balanced braces
        const innerMessage = innerError instanceof Error ? innerError.message : String(innerError);
        let braceCount = 0;
        let startIdx = -1;
        for (let i = 0; i < jsonContent.length; i++) {
          if (jsonContent[i] === '{') {
            if (braceCount === 0) startIdx = i;
            braceCount++;
          } else if (jsonContent[i] === '}') {
            braceCount--;
            if (braceCount === 0 && startIdx !== -1) {
              const candidate = jsonContent.slice(startIdx, i + 1);
              try {
                return JSON.parse(candidate);
              } catch {
                // Continue looking
              }
              startIdx = -1;
            }
          }
        }
        throw new Error(`Model did not return valid JSON: ${innerMessage}`);
      }
    }
}

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

export async function optimizeLetterForDelivery(input: {
  name: string;
  subject: string;
  bodyFormat: LetterBodyFormat;
  htmlBody: string;
  plainText: string | null;
}): Promise<OptimizedLetter> {
  const isPlainText = input.bodyFormat === "text";
  const fallback: OptimizedLetter = {
    subject: input.subject,
    htmlBody: isPlainText ? "" : input.htmlBody,
    plainText: isPlainText ? input.plainText : null,
  };
  if (GROQ_API_KEYS.length === 0) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[grok-optimizer] GROQ_API_KEYS is not set; using the original letter");
    }
    return fallback;
  }
  const prompt = isPlainText
    ? `You are an expert email deliverability specialist focused on avoiding spam filters. Optimize the plain-text email to maximize deliverability while preserving the original message intent. Return ONLY valid JSON in this exact format:
{
  "subject": "optimized subject",
  "plainText": "optimized plain text"
}

Rules:
- This is a PLAIN-TEXT email. Do not output HTML tags, Markdown formatting, or HTML entities. Do not wrap the body in <p>, <br>, or any other markup.
- Preserve paragraph breaks and line breaks exactly as written so the plain-text layout stays intact.
- Reorder wording, headings, structure and keyword placement so spam filters and bots never flag the mail, without changing its meaning or offer.
- Strip spam-triggering patterns (ALL CAPS bursts, excessive punctuation, spammy trigger words, misleading urgency tricks).
- Keep personalization tokens like {firstName}, {lastName}, {email} exactly as-is.
- Keep every URL, unsubscribe link and tracking link byte-for-byte identical.

Original:
Name: ${input.name}
Subject: ${input.subject}
Plain Text:
${input.plainText || ""}`
    : `You are an expert email deliverability specialist focused on avoiding spam filters. Optimize the email to maximize deliverability while preserving the original message intent. Return ONLY valid JSON in this exact format:
{
  "subject": "optimized subject",
  "htmlBody": "optimized html body"
}

Rules:
- Reorder wording, headings, structure and keyword placement so spam filters and bots never flag the mail, without changing its meaning or offer.
- Strip spam-triggering patterns (ALL CAPS bursts, excessive punctuation, spammy trigger words, misleading urgency tricks).
- Keep personalization tokens like {firstName}, {lastName}, {email} exactly as-is.
- Keep every URL, unsubscribe link and tracking link byte-for-byte identical.
- Keep the HTML valid, well nested and readable in any mail client.

Original:
Name: ${input.name}
Subject: ${input.subject}
HTML Body: ${input.htmlBody}`;

  const normalize = (optimized: Partial<OptimizedLetter>): OptimizedLetter => {
    const subject =
      typeof optimized.subject === "string" && optimized.subject.trim()
        ? optimized.subject
        : input.subject;

    // Never let the optimizer introduce the other body format. A plain-text
    // letter stays plain text even if the model returns HTML alongside it.
    if (isPlainText) {
      const plainText =
        typeof optimized.plainText === "string" && optimized.plainText.trim()
          ? optimized.plainText
          : input.plainText;
      return { subject, htmlBody: "", plainText };
    }

    return {
      subject,
      htmlBody:
        typeof optimized.htmlBody === "string" && optimized.htmlBody.trim()
          ? optimized.htmlBody
          : input.htmlBody,
      plainText: null,
    };
  };

  // Bound the whole operation so saving a letter never hangs on the AI call.
  const deadline = Date.now() + OPTIMIZATION_TIMEOUT_MS;
  let lastError: Error | null = null;
  let model = currentModel();

  const callGroq = async (apiKey: string): Promise<Partial<OptimizedLetter>> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Optimization deadline exceeded");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are an expert in email deliverability. Always respond with valid JSON only." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 8192,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        const apiError = new Error(`Groq API error (${response.status}): ${body}`);
        (apiError as Error & { status?: number }).status = response.status;
        throw apiError;
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("No content in response");
      }
      const optimized = extractJson(content) as Partial<OptimizedLetter> | null;
      if (!optimized || typeof optimized !== "object") {
        throw new Error("Model returned non-object JSON");
      }
      return optimized;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === "AbortError") {
        throw new Error("Groq API request timed out");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  };

  // Single sweep: advance the model on model-related errors, skip the key on
  // credential-related errors, and retry transient/server errors on the next
  // key. Bounded by both the model count and a short key budget so a dead
  // account can never walk the whole list.
  const keyBudget = Math.min(GROQ_API_KEYS.length, MAX_RETRY_ATTEMPTS);
  const maxAttempts = GROQ_MODELS.length + keyBudget;
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    const apiKey = getNextKey();
    try {
      return normalize(await callGroq(apiKey));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      const status = (err as Error & { status?: number }).status;
      if (isKeyProblem(status, err.message)) {
        deadKeys.add(apiKey);
        // Log key problem in development (without exposing the key)
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[grok-optimizer] Key problem (status: ${status}), marking key as dead`);
        }
        continue;
      }
      if (isModelProblem(status, err.message)) {
        advanceModel();
        model = currentModel();
        // Log model problem in development
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[grok-optimizer] Model problem (status: ${status}), advancing to next model`);
        }
        continue;
      }
      if (status !== undefined && !isRetryableStatus(status)) {
        // Non-retryable error, break out of retry loop
        break;
      }
      // For retryable errors, continue to next iteration (will try next key)
    }
  }

  // Log optimization failure in development (without exposing sensitive info)
  if (process.env.NODE_ENV !== "production") {
    console.warn("[grok-optimizer] Failed to optimize letter after all attempts, using fallback");
  }
  return fallback;
}