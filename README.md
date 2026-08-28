# log_monitor

Cloudflare Zero Trust Gateway HTTP 로그를 Grafana 대시보드로 보는 파이프라인.

```
Zero Trust Gateway HTTP 트래픽
      │
      ▼
Logpush (gateway_http) → R2 (buffer)
      │
      ▼
Worker cron ──── Loki push API (HTTPS, Cloudflare Access로 보호)
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

- [`gateway-log-pipeline/`](gateway-log-pipeline) — **현재 사용 중.** Zero Trust Gateway HTTP
  로그 **전체**(필터링 없음)를 R2에서 읽어 Loki로 전송하는 Cloudflare Worker. 전체 트래픽
  기준으로 대시보드를 구성하기 위한 것입니다.
- [`gateway-error-pipeline/`](gateway-error-pipeline) — **현재 미사용 (보관용).** 같은 구조지만
  에러(정책 차단 + 업스트림 4xx/5xx)만 걸러서 보내는 버전. 전체 로그 대신 에러만 필요해지면
  다시 꺼내 쓸 수 있도록 코드는 남겨뒀습니다.
- [`loki-grafana-azure-vm/`](loki-grafana-azure-vm) — Azure Ubuntu VM에 Loki(Azure Blob
  Storage를 저장 백엔드로 사용) + Grafana + Cloudflare Tunnel을 docker compose로 띄우는 스택.
  위 두 Worker 프로젝트가 공유합니다 (Loki job 라벨이 달라서 Grafana에서 구분됩니다:
  `gateway_http_logs` vs `gateway_http_errors`).

각 디렉터리의 README에 설정/배포 순서가 있습니다. 순서상 `loki-grafana-azure-vm`을 먼저
띄워서 Loki push URL을 확보한 뒤, `gateway-log-pipeline`을 그 URL로 배포하면 됩니다.
