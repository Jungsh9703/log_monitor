# log_monitor

Cloudflare Zero Trust Gateway HTTP 로그를 Grafana 대시보드로 보는 파이프라인.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jungsh9703/log_monitor/tree/main/gateway-log-pipeline)

위 버튼은 현재 사용 중인 `gateway-log-pipeline`의 Worker만 배포합니다 (R2 버킷 자동 생성 +
커서 저장용 Durable Object 마이그레이션 포함). Logpush job 생성과 Loki 관련 설정은 버튼이
대신해주지 않으니 아래 순서를 참고하세요.

```
Zero Trust Gateway HTTP 트래픽
      │
      ▼
Logpush (gateway_http) → R2 (buffer)
      │
      ▼
Worker cron ──── Loki push (HTTP + Basic Auth) ──▶ VM 공인 IP:3100
                                                         │
                                            Azure Ubuntu VM (네이티브 systemd, 컨테이너 없음)
                                            ┌──────────────────────────────┐
                                            │ nginx (Basic Auth) → Loki     │──▶ Azure Blob Storage
                                            │ (storage_config.azure)        │    (청크/인덱스)
                                            │ Grafana (:3000, Loki 직접 조회)│
                                            └──────────────────────────────┘
                                                         │
                                          브라우저 ──HTTP──▶ VM 공인 IP:3000
                                                (Grafana Dashboard)
```

도메인을 Cloudflare One 계정에 연결해두지 않은 상태라, Cloudflare Tunnel/Access 대신 VM의
공인 IP에 포트를 나눠서 직접 노출하는 방식을 씁니다 (Loki는 nginx Basic Auth로, Grafana는
자체 로그인으로 보호). 현재는 TLS 없이 평문 HTTP입니다 — 자세한 트레이드오프는
[`loki-grafana-azure-vm/README.md`](loki-grafana-azure-vm/README.md)의 "보안에 대해 미리
말씀드릴 것" 절 참고.

## 구성

- [`gateway-log-pipeline/`](gateway-log-pipeline) — **현재 사용 중.** Zero Trust Gateway HTTP
  로그 **전체**(필터링 없음)를 R2에서 읽어 Loki로 전송하는 Cloudflare Worker. 전체 트래픽
  기준으로 대시보드를 구성하기 위한 것입니다.
- [`gateway-error-pipeline/`](gateway-error-pipeline) — **현재 미사용 (보관용).** 같은 구조지만
  에러(정책 차단 + 업스트림 4xx/5xx)만 걸러서 보내는 버전. 전체 로그 대신 에러만 필요해지면
  다시 꺼내 쓸 수 있도록 코드는 남겨뒀습니다.
- [`loki-grafana-azure-vm/`](loki-grafana-azure-vm) — Azure Ubuntu VM에 Loki(Azure Blob
  Storage를 저장 백엔드로 사용) + Grafana를 네이티브 systemd 서비스로 띄우는 스택(컨테이너
  없음). 위 두 Worker 프로젝트가 공유합니다 (Loki job 라벨이 달라서 Grafana에서 구분됩니다:
  `gateway_http_logs` vs `gateway_http_errors`).

각 디렉터리의 README에 설정/배포 순서가 있습니다. 순서상 `loki-grafana-azure-vm`을 먼저
띄워서 Loki push URL을 확보한 뒤, `gateway-log-pipeline`을 그 URL로 배포하면 됩니다.
