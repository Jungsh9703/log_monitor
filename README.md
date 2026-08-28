# log_monitor

Cloudflare Zero Trust Gateway HTTP 에러 로그를 걸러서 Grafana 대시보드로 보는 파이프라인.

```
Zero Trust Gateway 에러
      │
      ▼
Logpush (gateway_http) → R2 (buffer)
      │
      ▼
Worker cron (필터링) ──── Loki push API (HTTPS, Cloudflare Access로 보호)
                                  │
                     Azure Ubuntu VM
                     ┌────────────────────────────┐
                     │  Loki (storage_config.azure)│──▶ Azure Blob Storage (청크/인덱스)
                     │  Grafana (Loki datasource)  │
                     │  cloudflared (Tunnel)       │
                     └────────────────────────────┘
                                  │
                          Grafana Dashboard (브라우저)
```

## 구성

- [`gateway-error-pipeline/`](gateway-error-pipeline) — Cloudflare Worker. Logpush가 R2에
  떨어뜨린 `gateway_http` 로그를 cron으로 읽어 에러(정책 차단 + 업스트림 4xx/5xx)만 걸러
  Loki push API로 전송합니다.
- [`loki-grafana-azure-vm/`](loki-grafana-azure-vm) — Azure Ubuntu VM에 Loki(Azure Blob
  Storage를 저장 백엔드로 사용) + Grafana + Cloudflare Tunnel을 docker compose로 띄우는 스택.

각 디렉터리의 README에 설정/배포 순서가 있습니다. 순서상 `loki-grafana-azure-vm`을 먼저
띄워서 Loki push URL을 확보한 뒤, `gateway-error-pipeline`을 그 URL로 배포하면 됩니다.
