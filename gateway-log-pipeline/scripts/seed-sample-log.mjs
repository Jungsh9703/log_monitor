// Generates a small gzip NDJSON file shaped like a Cloudflare Logpush
// `gateway_http` delivery and drops it into the local R2 simulator that
// `wrangler dev` uses, so ingestion can be exercised end-to-end without real
// Cloudflare/Loki traffic. Field names (PascalCase) and shapes here are
// copied from a real object downloaded directly from the Logpush-fed R2
// bucket -- NOT from Cloudflare's docs or the Zero Trust dashboard's log
// viewer, both of which describe a different (snake_case) schema that
// turned out to belong to a separate live-query API, not Logpush.
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const nowMs = Date.now();

function iso(msAgo) {
  return new Date(nowMs - msAgo).toISOString();
}

const hosts = ["example.com", "internal-api.example", "docs.example", "cdn.example"];

const samples = [
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[0], URL: "https://example.com/", HTTPMethod: "GET" },
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[1], URL: "https://internal-api.example/v1/orders", HTTPMethod: "GET" },
  { Action: "allow", HTTPStatusCode: 304, HTTPHost: hosts[2], URL: "https://docs.example/guide", HTTPMethod: "GET" },
  { Action: "block", HTTPStatusCode: 403, HTTPHost: "malware.test", URL: "https://malware.test/payload", HTTPMethod: "GET", PolicyID: "00000001-block-known-malware", PolicyName: "Block Known Malware" },
  { Action: "allow", HTTPStatusCode: 502, HTTPHost: "flaky-upstream.example", URL: "https://flaky-upstream.example/api", HTTPMethod: "POST" },
  { Action: "isolate", HTTPStatusCode: 200, HTTPHost: "risky-site.example", URL: "https://risky-site.example/", HTTPMethod: "GET", PolicyID: "00000002-isolate-risky-category", PolicyName: "Isolate Risky Category", IsIsolated: true },
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[3], URL: "https://cdn.example/app.js", HTTPMethod: "GET" },
  { Action: "block", HTTPStatusCode: 403, HTTPHost: "social-media.example", URL: "https://social-media.example/feed", HTTPMethod: "GET", PolicyID: "00000003-block-social-media", PolicyName: "Block Social Media", CategoryIDs: [12], CategoryNames: ["Social Networking"] },
  { Action: "allow", HTTPStatusCode: 500, HTTPHost: hosts[1], URL: "https://internal-api.example/v1/reports", HTTPMethod: "GET" },
  { Action: "allow", HTTPStatusCode: 404, HTTPHost: hosts[0], URL: "https://example.com/missing", HTTPMethod: "GET" },
];

const lines = samples.map((s, idx) =>
  JSON.stringify({
    Datetime: iso((samples.length - idx) * 1000),
    RequestID: `req-${String(idx + 1).padStart(4, "0")}`,
    Email: `user${(idx % 4) + 1}@example.com`,
    SourceIPCountryCode: "KR",
    DestinationIPCountryCode: "US",
    CategoryIDs: [],
    CategoryNames: [],
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
