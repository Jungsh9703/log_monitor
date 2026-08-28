import type { Env } from "./env";

export interface IngestConfig {
  maxObjectsPerRun: number;
  maxLinesPerObjectRun: number;
  completedSetCap: number;
}

export function loadConfig(env: Env): IngestConfig {
  return {
    maxObjectsPerRun: Number(env.MAX_OBJECTS_PER_RUN ?? "5"),
    maxLinesPerObjectRun: Number(env.MAX_LINES_PER_OBJECT_RUN ?? "2000"),
    completedSetCap: Number(env.COMPLETED_SET_CAP ?? "3000"),
  };
}
