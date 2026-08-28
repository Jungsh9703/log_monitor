import type { Env } from "./env";
import { loadConfig } from "./config";
import { loadCompletedSet, saveCompletedSet, getObjectCursor, putObjectCursor, deleteObjectCursor } from "./cursor";
import { extractError, type NormalizedError } from "./filter";
import { pushToLoki } from "./loki";

async function decompressToText(obj: R2ObjectBody, key: string): Promise<string> {
  const stream = key.endsWith(".gz") ? obj.body.pipeThrough(new DecompressionStream("gzip")) : obj.body;
  return await new Response(stream).text();
}

export interface IngestSummary {
  objectsTouched: number;
  linesRead: number;
  errorsFound: number;
}

export async function runIngestion(env: Env): Promise<IngestSummary> {
  const summary: IngestSummary = { objectsTouched: 0, linesRead: 0, errorsFound: 0 };
  const cfg = loadConfig(env);

  const completedSet = await loadCompletedSet(env);
  const listing = await env.RAW_LOGS_BUCKET.list({ limit: Math.max(cfg.maxObjectsPerRun * 20, 200) });
  const candidateKeys = listing.objects
    .map((o) => o.key)
    .filter((k) => !completedSet.has(k))
    .slice(0, cfg.maxObjectsPerRun);

  const batchRecords: NormalizedError[] = [];
  const newlyCompleted: string[] = [];

  for (const key of candidateKeys) {
    const obj = await env.RAW_LOGS_BUCKET.get(key);
    if (!obj) continue;

    const cursor = await getObjectCursor(env, key);
    const text = await decompressToText(obj, key);
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    let i = cursor?.nextLine ?? 0;
    const startLine = i;
    const budgetEnd = Math.min(lines.length, i + cfg.maxLinesPerObjectRun);

    for (; i < budgetEnd; i++) {
      const line = lines[i];
      if (!line) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const err = extractError(raw);
      if (!err) continue;
      batchRecords.push(err);
    }

    const completed = i >= lines.length;
    if (completed) {
      newlyCompleted.push(key);
      await deleteObjectCursor(env, key);
    } else {
      await putObjectCursor(env, key, { nextLine: i, totalLines: lines.length });
    }

    summary.objectsTouched++;
    summary.linesRead += i - startLine;
  }

  summary.errorsFound = batchRecords.length;

  // One batched push per run, not one per line -- Loki is a network round
  // trip, unlike the D1 writes the sibling projects use.
  await pushToLoki(env, batchRecords);

  for (const k of newlyCompleted) completedSet.add(k);
  await saveCompletedSet(env, completedSet, cfg.completedSetCap);

  return summary;
}
