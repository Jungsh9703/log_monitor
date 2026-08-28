import type { Env } from "./env";
import type { NormalizedError } from "./filter";

function groupByAction(records: NormalizedError[]): Map<string, NormalizedError[]> {
  const map = new Map<string, NormalizedError[]>();
  for (const r of records) {
    const list = map.get(r.action) ?? [];
    list.push(r);
    map.set(r.action, list);
  }
  return map;
}

/**
 * Pushes normalized error records to Loki. Stream labels are kept to the
 * single low-cardinality `action` field (Loki indexes by label set, so
 * high-cardinality values like url/ray_id/host must NOT become labels) --
 * everything else, including the full original record, rides in the log
 * line body as JSON for LogQL `| json` filtering/aggregation in Grafana.
 * Loki is the only durable store here (its chunks live in Azure Blob), so
 * the raw record is shipped in full rather than a trimmed subset.
 */
export async function pushToLoki(env: Env, records: NormalizedError[]): Promise<void> {
  if (records.length === 0) return;
  if (!env.LOKI_URL) {
    console.warn("gateway-error-pipeline: Loki destination not configured, skipping push");
    return;
  }

  const grouped = groupByAction(records);
  const streams = [...grouped.entries()].map(([action, recs]) => ({
    stream: { job: "gateway_http_errors", action },
    values: recs
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((r) => [
        String(r.timestampMs * 1_000_000), // Loki wants a nanosecond epoch string
        JSON.stringify({
          ray_id: r.rayId,
          status_code: r.statusCode,
          policy_id: r.policyId,
          policy_name: r.policyName,
          host: r.host,
          url: r.url,
          method: r.method,
          identity: r.identity,
          raw: r.raw,
        }),
      ]),
  }));

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.LOKI_USERNAME && env.LOKI_API_KEY) {
    headers.Authorization = `Basic ${btoa(`${env.LOKI_USERNAME}:${env.LOKI_API_KEY}`)}`;
  }
  // Cloudflare Access Service Token, if the VM's Loki push endpoint is
  // fronted by a Cloudflare Tunnel + Access application (recommended: no
  // inbound port needs to be opened on the VM, and auth is Zero-Trust-native
  // rather than a bespoke reverse-proxy Basic Auth).
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }

  const res = await fetch(env.LOKI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ streams }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Loki push failed: ${res.status} ${body.slice(0, 500)}`);
  }
}
