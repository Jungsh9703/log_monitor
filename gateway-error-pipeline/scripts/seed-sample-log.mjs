// Generates a small gzip NDJSON file shaped like a Cloudflare Logpush
// `gateway_http` delivery and drops it into the local R2 simulator that
// `wrangler dev` uses, so ingestion can be exercised end-to-end without real
// Cloudflare/Azure/Loki traffic.
import { gzipSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const now = Date.now();

function iso(msAgo) {
  return new Date(now - msAgo).toISOString();
}

const samples = [
  {
    Action: "allow",
    HTTPStatusCode: 200,
    HTTPHost: "example.com",
    URL: "https://example.com/",
    Method: "GET",
    Email: "user1@example.com",
    PolicyID: "pol-allow-1",
    PolicyName: "Default Allow",
    RayID: "ray-0001",
  },
  {
    Action: "block",
    HTTPStatusCode: 403,
    HTTPHost: "malware.test",
    URL: "https://malware.test/payload",
    Method: "GET",
    Email: "user2@example.com",
    PolicyID: "pol-block-1",
    PolicyName: "Block Known Malware",
    RayID: "ray-0002",
  },
  {
    Action: "allow",
    HTTPStatusCode: 502,
    HTTPHost: "flaky-upstream.example",
    URL: "https://flaky-upstream.example/api",
    Method: "POST",
    Email: "user3@example.com",
    PolicyID: "pol-allow-1",
    PolicyName: "Default Allow",
    RayID: "ray-0003",
  },
  {
    Action: "isolate",
    HTTPStatusCode: 200,
    HTTPHost: "risky-site.example",
    URL: "https://risky-site.example/",
    Method: "GET",
    Email: "user1@example.com",
    PolicyID: "pol-isolate-1",
    PolicyName: "Isolate Risky Category",
    RayID: "ray-0004",
  },
  {
    Action: "block",
    HTTPStatusCode: 403,
    HTTPHost: "social-media.example",
    URL: "https://social-media.example/feed",
    Method: "GET",
    Email: "user4@example.com",
    PolicyID: "pol-block-2",
    PolicyName: "Block Social Media",
    RayID: "ray-0005",
  },
  {
    Action: "allow",
    HTTPStatusCode: 500,
    HTTPHost: "internal-api.example",
    URL: "https://internal-api.example/v1/orders",
    Method: "GET",
    Email: "user2@example.com",
    PolicyID: "pol-allow-1",
    PolicyName: "Default Allow",
    RayID: "ray-0006",
  },
];

const lines = samples.map((s, idx) => JSON.stringify({ Datetime: iso((samples.length - idx) * 1000), ...s }));
const ndjson = lines.join("\n") + "\n";
const gz = gzipSync(Buffer.from(ndjson, "utf8"));

mkdirSync("scripts/.tmp", { recursive: true });
const outPath = `scripts/.tmp/sample-${now}.log.gz`;
writeFileSync(outPath, gz);

const key = `sample-${now}.log.gz`;
console.log(`Writing ${lines.length} sample lines to local R2 as ${key} ...`);
execSync(`npx wrangler r2 object put gateway-error-raw/${key} --file="${outPath}" --local`, {
  stdio: "inherit",
});
console.log("Done. Now trigger ingestion with: curl -X POST http://127.0.0.1:8787/run");
