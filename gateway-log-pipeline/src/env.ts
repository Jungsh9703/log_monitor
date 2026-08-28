import type { IngestCursor } from "./cursor_do";

export interface Env {
  RAW_LOGS_BUCKET: R2Bucket;
  CURSOR_DO: DurableObjectNamespace<IngestCursor>;

  MAX_OBJECTS_PER_RUN: string;
  MAX_LINES_PER_OBJECT_RUN: string;
  COMPLETED_SET_CAP: string;

  /** Loki push API endpoint on the Azure VM, e.g. via a Cloudflare Tunnel
   * hostname: https://loki-push.example.com/loki/api/v1/push */
  LOKI_URL: string;

  /** Optional Basic Auth pair for Loki (e.g. behind a plain Nginx proxy). */
  LOKI_USERNAME?: string;
  LOKI_API_KEY?: string;

  /** Optional Cloudflare Access Service Token pair, if the Loki push
   * endpoint is fronted by a Cloudflare Tunnel + Access application. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  /** Optional shared secret gating the manual POST /run test endpoint. */
  RUN_TOKEN?: string;
}
