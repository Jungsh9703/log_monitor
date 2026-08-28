// Generates a small gzip NDJSON file shaped like a Cloudflare Logpush
// `gateway_http` delivery and drops it into the local R2 simulator that
// `wrangler dev` uses, so ingestion can be exercised end-to-end without real
// Cloudflare/Loki traffic. Unlike gateway-error-pipeline's sample, this one
// is mostly ordinary allow/200 traffic, since this pipeline ships everything.
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const now = Date.now();

function iso(msAgo) {
  return new Date(now - msAgo).toISOString();
}

const hosts = ["example.com", "internal-api.example", "docs.example", "cdn.example"];

const samples = [
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[0], URL: "https://example.com/", Method: "GET" },
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[1], URL: "https://internal-api.example/v1/orders", Method: "GET" },
  { Action: "allow", HTTPStatusCode: 304, HTTPHost: hosts[2], URL: "https://docs.example/guide", Method: "GET" },
  { Action: "block", HTTPStatusCode: 403, HTTPHost: "malware.test", URL: "https://malware.test/payload", Method: "GET", PolicyID: "pol-block-1", PolicyName: "Block Known Malware" },
  { Action: "allow", HTTPStatusCode: 502, HTTPHost: "flaky-upstream.example", URL: "https://flaky-upstream.example/api", Method: "POST" },
  { Action: "isolate", HTTPStatusCode: 200, HTTPHost: "risky-site.example", URL: "https://risky-site.example/", Method: "GET", PolicyID: "pol-isolate-1", PolicyName: "Isolate Risky Category" },
  { Action: "allow", HTTPStatusCode: 200, HTTPHost: hosts[3], URL: "https://cdn.example/app.js", Method: "GET" },
  { Action: "block", HTTPStatusCode: 403, HTTPHost: "social-media.example", URL: "https://social-media.example/feed", Method: "GET", PolicyID: "pol-block-2", PolicyName: "Block Social Media" },
  { Action: "allow", HTTPStatusCode: 500, HTTPHost: hosts[1], URL: "https://internal-api.example/v1/reports", Method: "GET" },
  { Action: "allow", HTTPStatusCode: 404, HTTPHost: hosts[0], URL: "https://example.com/missing", Method: "GET" },
];

const lines = samples.map((s, idx) =>
  JSON.stringify({
    Datetime: iso((samples.length - idx) * 1000),
    Email: `user${(idx % 4) + 1}@example.com`,
    RayID: `ray-${String(idx + 1).padStart(4, "0")}`,
    ...s,
  }),
);
const ndjson = lines.join("\n") + "\n";
const gz = gzipSync(Buffer.from(ndjson, "utf8"));

mkdirSync("scripts/.tmp", { recursive: true });
const outPath = `scripts/.tmp/sample-${now}.log.gz`;
writeFileSync(outPath, gz);

const key = `sample-${now}.log.gz`;
console.log(`Writing ${lines.length} sample lines to local R2 as ${key} ...`);
execSync(`npx wrangler r2 object put gateway-log-raw/${key} --file="${outPath}" --local`, {
  stdio: "inherit",
});
console.log("Done. Now trigger ingestion with: curl -X POST http://127.0.0.1:8787/run");
