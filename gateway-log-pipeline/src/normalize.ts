export interface LogRecord {
  timestampMs: number;
  rayId: string | null;
  action: string;
  statusCode: number | null;
  policyId: string | null;
  policyName: string | null;
  host: string | null;
  url: string | null;
  method: string | null;
  identity: string | null;
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
 * JSON becomes one record. Field names follow Cloudflare's documented
 * gateway_http schema, but verify against a real delivered object -- some
 * fields can be blank depending on plan/config (PolicyName in particular is
 * often blank; policyNames, if provided, resolves PolicyID via the
 * Cloudflare API instead -- see policy_names.ts).
 */
export function normalizeRecord(raw: Record<string, unknown>, policyNames?: Map<string, string>): LogRecord {
  const action = str(raw.Action);
  const statusCode = num(raw.HTTPStatusCode ?? raw.HttpStatusCode ?? raw.StatusCode);
  const policyId = str(raw.PolicyID);

  return {
    timestampMs: parseTimeMs(raw.Datetime),
    rayId: str(raw.RayID) ?? str(raw.RayId),
    action: action ?? "unknown",
    statusCode,
    policyId,
    policyName: (policyId && policyNames?.get(policyId)) || str(raw.PolicyName) || policyId,
    host: str(raw.HTTPHost) ?? str(raw.Host),
    url: str(raw.URL),
    method: str(raw.Method),
    identity: str(raw.Email) ?? str(raw.UserID),
    raw,
  };
}
