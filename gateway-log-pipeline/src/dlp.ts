import type { Env } from "./env";
import { decryptPayload } from "./crypto";

export interface DecryptedFields {
  genAiPromptRequest: string | null;
  genAiPromptResponse: string | null;
  genAiConversation: string | null;
  /** Decrypted context snippets from dlp_match_context_parsed.p, keyed by
   * their original index -- entries that fail to decrypt (wrong/rotated
   * key, budget exhausted) are simply omitted, not replaced with an error
   * string, since the raw encrypted blob is still preserved in `raw`. */
  dlpMatchedContext: Record<string, string> | null;
}

export const NO_DECRYPTED_FIELDS: DecryptedFields = {
  genAiPromptRequest: null,
  genAiPromptResponse: null,
  genAiConversation: null,
  dlpMatchedContext: null,
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

interface DlpMatchContextParsed {
  p?: Record<string, { k?: string; p?: string }>;
}

/**
 * Decrypts whatever encrypted content is present on one raw gateway_http
 * record: "Capture generative AI prompt content in logs"
 * (gen_ai_prompt_request/response/conversation) and DLP matched-data
 * context (dlp_match_context_parsed.p entries) -- both use the same HPKE
 * scheme (see crypto.ts). Spends from a shared per-run budget, since each
 * decrypt is a real ECDH + AEAD operation and a burst of matched lines in
 * one 1-minute cron run shouldn't blow the Workers CPU budget. Lines
 * skipped for budget aren't lost -- `raw` (the full original record) ships
 * to Loki regardless, encrypted blob and all, so nothing is unrecoverable.
 */
export async function decryptFields(
  raw: Record<string, unknown>,
  env: Env,
  budget: { remaining: number },
): Promise<DecryptedFields> {
  const privateKey = env.DLP_PRIVATE_KEY;
  if (!privateKey) return NO_DECRYPTED_FIELDS;

  const genAiPromptRequest = str(raw.gen_ai_prompt_request);
  const genAiPromptResponse = str(raw.gen_ai_prompt_response);
  const genAiConversation = str(raw.gen_ai_conversation);
  const dlpContext = raw.dlp_match_context_parsed as DlpMatchContextParsed | null | undefined;
  const dlpEntries = Object.entries(dlpContext?.p ?? {}).filter(
    (entry): entry is [string, { p: string }] => typeof entry[1]?.p === "string",
  );

  if (!genAiPromptRequest && !genAiPromptResponse && !genAiConversation && dlpEntries.length === 0) {
    return NO_DECRYPTED_FIELDS;
  }

  const decryptIfBudget = async (blob: string | null): Promise<string | null> => {
    if (!blob || budget.remaining <= 0) return null;
    budget.remaining--;
    const result = await decryptPayload(blob, privateKey);
    return result.ok ? (result.plaintext ?? null) : null;
  };

  const [genAiPromptRequestDec, genAiPromptResponseDec, genAiConversationDec] = await Promise.all([
    decryptIfBudget(genAiPromptRequest),
    decryptIfBudget(genAiPromptResponse),
    decryptIfBudget(genAiConversation),
  ]);

  let dlpMatchedContext: Record<string, string> | null = null;
  for (const [key, entry] of dlpEntries) {
    const plaintext = await decryptIfBudget(entry.p);
    if (plaintext) {
      dlpMatchedContext ??= {};
      dlpMatchedContext[key] = plaintext;
    }
  }

  return {
    genAiPromptRequest: genAiPromptRequestDec,
    genAiPromptResponse: genAiPromptResponseDec,
    genAiConversation: genAiConversationDec,
    dlpMatchedContext,
  };
}
