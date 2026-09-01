import type { Env } from "./env";
import { loadConfig } from "./config";
import { loadCompletedSet, saveCompletedSet, getObjectCursor, putObjectCursor, deleteObjectCursor } from "./cursor";
import { normalizeRecord, type LogRecord } from "./normalize";
import { pushToLoki } from "./loki";
import { getPolicyNameMap } from "./policy_names";
import { getDlpNameMap } from "./dlp_profile_names";
import { decryptFields } from "./dlp";

async function decompressToText(obj: R2ObjectBody, key: string): Promise<string> {
  const stream = key.endsWith(".gz") ? obj.body.pipeThrough(new DecompressionStream("gzip")) : obj.body;
  return await new Response(stream).text();
}

export interface IngestSummary {
  objectsTouched: number;
  linesRead: number;
  recordsShipped: number;
}

export async function runIngestion(env: Env): Promise<IngestSummary> {
  const summary: IngestSummary = { objectsTouched: 0, linesRead: 0, recordsShipped: 0 };
  const cfg = loadConfig(env);

  const [completedSet, policyNames, dlpNames] = await Promise.all([
    loadCompletedSet(env),
    getPolicyNameMap(env),
    getDlpNameMap(env),
  ]);
  const listing = await env.RAW_LOGS_BUCKET.list({ limit: Math.max(cfg.maxObjectsPerRun * 20, 200) });
  const candidateKeys = listing.objects
    .map((o) => o.key)
    .filter((k) => !completedSet.has(k))
    .slice(0, cfg.maxObjectsPerRun);

  const batchRecords: LogRecord[] = [];
  const newlyCompleted: string[] = [];
  const decryptBudget = { remaining: cfg.maxDecryptionsPerRun };

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
      // No filtering -- every parseable line ships, not just errors.
      const record = normalizeRecord(raw, policyNames, dlpNames);
      const decrypted = await decryptFields(raw, env, decryptBudget);
      batchRecords.push({ ...record, ...decrypted });
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

  summary.recordsShipped = batchRecords.length;

  // Persist "completed" bookkeeping unconditionally, even if the Loki push
  // throws -- otherwise a failed push leaves these objects with no cursor
  // AND not in completedSet, so the next run re-reads them from scratch
  // and resubmits their (now even staler) original timestamps. Given
  // Loki's per-stream ordering means a retry of old data is often no more
  // likely to succeed than the first attempt (time only moves one
  // direction), that non-atomicity was actively harmful: it could pin the
  // run budget on the same doomed objects indefinitely. Prefer forward
  // progress -- still surface the error afterward so it isn't silently lost.
  let pushError: unknown;
  try {
    await pushToLoki(env, batchRecords);
  } catch (err) {
    pushError = err;
  }

  for (const k of newlyCompleted) completedSet.add(k);
  await saveCompletedSet(env, completedSet, cfg.completedSetCap);

  if (pushError) throw pushError;

  return summary;
}
