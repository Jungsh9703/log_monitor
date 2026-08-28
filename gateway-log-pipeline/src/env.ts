import type { IngestCursor } from "./cursor_do";

export interface Env {
  RAW_LOGS_BUCKET: R2Bucket;
  CURSOR_DO: DurableObjectNamespace<IngestCursor>;

  MAX_OBJECTS_PER_RUN: string;
  MAX_LINES_PER_OBJECT_RUN: string;
  COMPLETED_SET_CAP: string;

  /** Loki push API endpoint on the Azure VM. Must be a hostname, not a bare
   * IP -- Workers' fetch() routes IP-literal URLs through Cloudflare's edge
   * and gets back its own "error code: 1003" instead of ever reaching the
   * VM. With no real domain, use nip.io: e.g.
   * http://<vm-public-ip>.nip.io:3100/loki/api/v1/push */
  LOKI_URL: string;

  /** Basic Auth pair for Loki's nginx proxy. USERNAME is a plain var (not
   * sensitive); API_KEY is a secret. Both optional -- unset skips this auth
   * path entirely (e.g. if using CF_ACCESS_* instead). */
  LOKI_USERNAME?: string;
  LOKI_API_KEY?: string;

  /** Optional Cloudflare Access Service Token pair, if the Loki push
   * endpoint is fronted by a Cloudflare Tunnel + Access application. */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  /** Optional shared secret gating the manual POST /run test endpoint. */
  RUN_TOKEN?: string;
}
