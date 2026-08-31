// Generates a small gzip NDJSON file shaped like a Cloudflare Logpush
// `gateway_http` delivery and drops it into the local R2 simulator that
// `wrangler dev` uses, so ingestion can be exercised end-to-end without real
// Cloudflare/Loki traffic. Field names/shapes here are copied from a real
// delivered record (snake_case, action/http_method as numeric codes with a
// separate *_name string) -- not Cloudflare's docs, which describe a
// different (PascalCase) naming convention that this account doesn't use.
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const nowMs = Date.now();
const nowSec = Math.floor(nowMs / 1000);

const hosts = ["example.com", "internal-api.example", "docs.example", "cdn.example"];

const samples = [
  { action: 1, action_name: "allow", http_status_code: 200, http_host: hosts[0], url: "https://example.com/", http_method_name: "GET" },
  { action: 1, action_name: "allow", http_status_code: 200, http_host: hosts[1], url: "https://internal-api.example/v1/orders", http_method_name: "GET" },
  { action: 1, action_name: "allow", http_status_code: 304, http_host: hosts[2], url: "https://docs.example/guide", http_method_name: "GET" },
  { action: 0, action_name: "block", http_status_code: 403, http_host: "malware.test", url: "https://malware.test/payload", http_method_name: "GET", rule_id: "00000001-block-known-malware" },
  { action: 1, action_name: "allow", http_status_code: 502, http_host: "flaky-upstream.example", url: "https://flaky-upstream.example/api", http_method_name: "POST" },
  { action: 2, action_name: "isolate", http_status_code: 200, http_host: "risky-site.example", url: "https://risky-site.example/", http_method_name: "GET", rule_id: "00000002-isolate-risky-category", is_isolated: true },
  { action: 1, action_name: "allow", http_status_code: 200, http_host: hosts[3], url: "https://cdn.example/app.js", http_method_name: "GET" },
  { action: 0, action_name: "block", http_status_code: 403, http_host: "social-media.example", url: "https://social-media.example/feed", http_method_name: "GET", rule_id: "00000003-block-social-media" },
  { action: 1, action_name: "allow", http_status_code: 500, http_host: hosts[1], url: "https://internal-api.example/v1/reports", http_method_name: "GET" },
  { action: 1, action_name: "allow", http_status_code: 404, http_host: hosts[0], url: "https://example.com/missing", http_method_name: "GET" },
];

const lines = samples.map((s, idx) =>
  JSON.stringify({
    datetime: nowSec - (samples.length - idx),
    request_id: `req-${String(idx + 1).padStart(4, "0")}`,
    email: `user${(idx % 4) + 1}@example.com`,
    src_country: "KR",
    dst_country: "US",
    category_ids: [],
    ...s,
  }),
);
const ndjson = lines.join("\n") + "\n";
const gz = gzipSync(Buffer.from(ndjson, "utf8"));

mkdirSync("scripts/.tmp", { recursive: true });
const outPath = `scripts/.tmp/sample-${nowMs}.log.gz`;
writeFileSync(outPath, gz);

const key = `sample-${nowMs}.log.gz`;
console.log(`Writing ${lines.length} sample lines to local R2 as ${key} ...`);
execSync(`npx wrangler r2 object put gateway-log-raw/${key} --file="${outPath}" --local`, {
  stdio: "inherit",
});
console.log("Done. Now trigger ingestion with: curl -X POST http://127.0.0.1:8787/run");
