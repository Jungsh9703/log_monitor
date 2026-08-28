export interface NormalizedError {
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
  /** Full original log record. Loki (backed by Azure Blob) is now the only
   * durable store, so the complete record rides along rather than just the
   * extracted convenience fields -- nothing is dropped on the way in. */
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
 * Decides whether one gateway_http log line is an "error" worth shipping:
 * either a policy block/isolate/override (Action present and not "allow"),
 * or a real upstream HTTP error (HTTPStatusCode >= 400). Field names follow
 * Cloudflare's documented gateway_http schema, but verify against a real
 * delivered object -- some fields can be blank depending on plan/config.
 */
export function extractError(raw: Record<string, unknown>): NormalizedError | null {
  const action = str(raw.Action);
  const statusCode = num(raw.HTTPStatusCode ?? raw.HttpStatusCode ?? raw.StatusCode);

  const isPolicyBlock = action !== null && action.toLowerCase() !== "allow";
  const isHttpError = statusCode !== null && statusCode >= 400;
  if (!isPolicyBlock && !isHttpError) return null;

  return {
    timestampMs: parseTimeMs(raw.Datetime),
    rayId: str(raw.RayID) ?? str(raw.RayId),
    action: action ?? "http_error",
    statusCode,
    policyId: str(raw.PolicyID),
    policyName: str(raw.PolicyName) ?? str(raw.PolicyID),
    host: str(raw.HTTPHost) ?? str(raw.Host),
    url: str(raw.URL),
    method: str(raw.Method),
    identity: str(raw.Email) ?? str(raw.UserID),
    raw,
  };
}
