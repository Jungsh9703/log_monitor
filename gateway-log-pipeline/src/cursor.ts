import type { Env } from "./env";

const COMPLETED_SET_KEY = "completed-set";

export interface ObjectCursor {
  nextLine: number;
  totalLines: number;
}

/** Rolling set of fully-processed R2 object keys, stored as one JSON array
 * so a run only costs a single KV read/write instead of one per candidate
 * object. Trimmed to `cap` entries (oldest first) by saveCompletedSet. */
export async function loadCompletedSet(env: Env): Promise<Set<string>> {
  const raw = await env.CURSOR_KV.get(COMPLETED_SET_KEY);
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

export async function saveCompletedSet(env: Env, set: Set<string>, cap: number): Promise<void> {
  let arr = [...set];
  if (arr.length > cap) arr = arr.slice(arr.length - cap);
  await env.CURSOR_KV.put(COMPLETED_SET_KEY, JSON.stringify(arr));
}

export async function getObjectCursor(env: Env, key: string): Promise<ObjectCursor | null> {
  const raw = await env.CURSOR_KV.get(`cursor:${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ObjectCursor;
  } catch {
    return null;
  }
}

export async function putObjectCursor(env: Env, key: string, cursor: ObjectCursor): Promise<void> {
  await env.CURSOR_KV.put(`cursor:${key}`, JSON.stringify(cursor));
}

export async function deleteObjectCursor(env: Env, key: string): Promise<void> {
  await env.CURSOR_KV.delete(`cursor:${key}`);
}
