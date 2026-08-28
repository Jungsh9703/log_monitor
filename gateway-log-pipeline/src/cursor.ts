import type { Env } from "./env";
import type { ObjectCursor } from "./cursor_do";

export type { ObjectCursor };

// One fixed Durable Object instance backs the whole pipeline's cursor
// state -- see cursor_do.ts for why this replaced Workers KV.
const SINGLETON_ID_NAME = "gateway-log-pipeline-cursor";

function stub(env: Env) {
  const id = env.CURSOR_DO.idFromName(SINGLETON_ID_NAME);
  return env.CURSOR_DO.get(id);
}

export async function loadCompletedSet(env: Env): Promise<Set<string>> {
  const arr = await stub(env).getCompletedSet();
  return new Set(arr);
}

export async function saveCompletedSet(env: Env, set: Set<string>, cap: number): Promise<void> {
  await stub(env).saveCompletedSet([...set], cap);
}

export async function getObjectCursor(env: Env, key: string): Promise<ObjectCursor | null> {
  return stub(env).getObjectCursor(key);
}

export async function putObjectCursor(env: Env, key: string, cursor: ObjectCursor): Promise<void> {
  await stub(env).putObjectCursor(key, cursor);
}

export async function deleteObjectCursor(env: Env, key: string): Promise<void> {
  await stub(env).deleteObjectCursor(key);
}
