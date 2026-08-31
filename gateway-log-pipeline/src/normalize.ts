export interface LogRecord {
  timestampMs: number;
  requestId: string | null;
  action: string;
  statusCode: number | null;
  method: string | null;
  policyId: string | null;
  policyName: string | null;
  host: string | null;
  url: string | null;
  identity: string | null;
  isIsolated: boolean;
  srcCountry: string | null;
  dstCountry: string | null;
  categoryIds: number[];
  /** Decrypted separately in ingest.ts (see dlp.ts) -- normalizeRecord
   * always initializes these to null since it's synchronous. */
  genAiPromptRequest: string | null;
  genAiPromptResponse: string | null;
  genAiConversation: string | null;
  dlpMatchedContext: Record<string, string> | null;
  /** Full original log record, so nothing is dropped on the way in --
   * Loki (backed by Azure Blob) is the only durable store here. */
  raw: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

/** Parses a Cloudflare log timestamp (RFC3339 or epoch in s/ms/us/ns) into epoch ms. */
export function parseTimeMs(value: unknown): number {
  if (value === null || value === undefined) return Date.now();
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(asNumber) && String(value).trim() !== "") {
    if (asNumber > 1e18) return Math.round(asNumber / 1e6); // ns -> ms
    if (asNumber > 1e15) return Math.round(asNumber / 1e3); // us -> ms
    if (asNumber > 1e12) return Math.round(asNumber); // already ms
    if (asNumber > 1e9) return Math.round(asNumber * 1000); // seconds -> ms
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Normalizes every gateway_http log line -- unlike gateway-error-pipeline's
 * extractError, this never filters anything out; every line that parses as
 * JSON becomes one record.
 *
 * Field names are snake_case (confirmed against a real delivered record --
 * NOT the PascalCase field names Cloudflare's docs describe for some other
 * Logpush datasets): datetime (epoch seconds), request_id, action (a
 * numeric code) + action_name (the string we actually want, e.g. "allow"),
 * http_host, http_status_code, http_method_name, url, email, user_id,
 * rule_id (the policy's ID -- there is no rule_name/policy_name field in
 * the raw log at all, so a human-readable name can only come from
 * policyNames, resolved separately via the Cloudflare API -- see
 * policy_names.ts), is_isolated, src_country, dst_country, category_ids.
 */
export function normalizeRecord(raw: Record<string, unknown>, policyNames?: Map<string, string>): LogRecord {
  const policyId = str(raw.rule_id);

  return {
    timestampMs: parseTimeMs(raw.datetime),
    requestId: str(raw.request_id),
    action: str(raw.action_name) ?? "unknown",
    statusCode: num(raw.http_status_code),
    method: str(raw.http_method_name),
    policyId,
    policyName: (policyId && policyNames?.get(policyId)) || policyId,
    host: str(raw.http_host),
    url: str(raw.url),
    identity: str(raw.email) || str(raw.user_id),
    isIsolated: raw.is_isolated === true,
    srcCountry: str(raw.src_country),
    dstCountry: str(raw.dst_country),
    categoryIds: numArray(raw.category_ids),
    genAiPromptRequest: null,
    genAiPromptResponse: null,
    genAiConversation: null,
    dlpMatchedContext: null,
    raw,
  };
}
