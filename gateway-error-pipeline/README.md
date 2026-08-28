# Gateway Error Pipeline

> **현재 미사용** — `gateway-log-pipeline`(전체 로그 수집)으로 대체되어 지금은 배포하지
> 않습니다. 나중에 에러만 다시 걸러보고 싶어지면 이 프로젝트를 그대로 배포하면 됩니다.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jungsh9703/log_monitor/tree/main/gateway-error-pipeline)

Zero Trust Gateway HTTP 로그 중 **에러(정책 차단 + 업스트림 4xx/5xx)** 만 걸러서 Grafana
대시보드에 실시간으로 띄우기 위한 Cloudflare Worker입니다.

```
Zero Trust Gateway 에러 발생
        │
        ▼
Logpush job (dataset: gateway_http) ─────────▶ R2 bucket (raw gzip NDJSON)
                                                        │
                                          Worker cron (5분, 커서로 이어서 처리)
                                          1) gunzip + NDJSON 파싱
                                          2) Action!=allow 또는 HTTPStatusCode>=400 필터링
                                          3) 정규화된 레코드(+원본 전체) → Loki push
                                                        │
                                                        ▼
                                   Loki (Azure Ubuntu VM, storage_config.azure)
                                   → 청크/인덱스는 Azure Blob Storage에 저장
                                                        │
                                                        ▼
                                              Grafana Dashboard
```

Loki + Grafana를 실제로 띄우는 Azure VM 스택은 별도 프로젝트
[`../loki-grafana-azure-vm`](../loki-grafana-azure-vm)에 있습니다. 이 Worker는 그쪽 Loki의
push API에 HTTPS로 쏘기만 하고, 로그의 영구 저장(Azure Blob)은 Loki 자체가 담당합니다 — Worker가
Blob에 별도로 업로드하지 않습니다.

## 왜 Logpush → HTTPS Worker가 아니라 Logpush → R2 → Worker cron인가

Logpush를 Worker의 HTTPS 엔드포인트로 직접 향하게 하면 Logpush가 보내는 각 배치를 그 자리에서
동기적으로 gunzip+파싱해야 하는데, 배치가 크면 Worker의 CPU 시간/응답 시간 제한에 걸릴 수
있습니다. 이 계정에서 이미 검증된 `../workers`, `../policy-block-monitor` 프로젝트와 동일하게,
Logpush는 R2에 파일만 떨어뜨리고(수동적, CPU 제한 없음) Worker cron이 오브젝트별 커서
(`CURSOR_KV`)로 나눠서 처리하는 방식을 그대로 재사용합니다. 대용량 오브젝트도 여러 번의 cron
실행에 걸쳐 안전하게 끝까지 처리됩니다.

## Worker → Loki 연결은 어떻게 보호하나

Worker는 Cloudflare 엣지에서 나가는 요청이라 고정 IP로 방화벽 허용을 걸 수 없습니다. 그래서
Loki push 엔드포인트를 Azure VM 위에서 **Cloudflare Tunnel**로 노출하고(인바운드 포트를 열
필요가 없음), **Cloudflare Access의 Service Token**으로 인증합니다 — Worker는 매 요청에
`CF-Access-Client-Id` / `CF-Access-Client-Secret` 헤더 두 개만 붙이면 됩니다 (`src/loki.ts`).
자세한 VM/Tunnel/Access 설정은 [`../loki-grafana-azure-vm/README.md`](../loki-grafana-azure-vm/README.md)를 참고하세요.

## 로컬 동작 확인 (필터/파싱 로직만, Loki 없이도 가능)

실제 Azure VM 없이도 Worker의 R2 읽기 → gunzip → 파싱 → 필터링 로직은 로컬에서 바로 확인할 수
있습니다.

```bash
npm install
npm run dev
```

다른 터미널에서:

```bash
npm run seed:local          # 샘플 gateway_http 로그를 로컬 R2에 주입
curl -X POST http://127.0.0.1:8787/run
```

`/run` 응답의 `errorsFound`가 0보다 크면 파싱/필터링은 정상입니다 (샘플 데이터는 block 2건 +
isolate 1건 + 5xx 2건 = 5건이 잡히도록 구성되어 있습니다). 이 단계에서는 `LOKI_URL`이 아직
가짜 값이라 마지막 `pushToLoki` 호출은 실패하는 게 정상입니다 — 그 앞까지(R2/KV/필터)가
문제없이 실행됐다는 뜻입니다.

Loki까지 포함한 전체 흐름을 로컬 Docker로 가볍게 검증해보고 싶다면(Azure 없이, filesystem
백엔드로) `docker-compose.yml`을 띄우고 `.dev.vars`에 `LOKI_URL=http://127.0.0.1:3100/loki/api/v1/push`를
넣은 뒤 같은 과정을 반복하면 됩니다:

```bash
docker compose up -d   # 로컬 Loki(파일시스템 백엔드) + Grafana
```

- Grafana: http://localhost:3000 (익명 Admin 접속 허용)
- 좌측 Dashboards → **Gateway HTTP Errors**

이건 어디까지나 로컬 스모크 테스트용이고, 실제 배포에서는 이 Loki 대신
`../loki-grafana-azure-vm`의 Azure Blob 백엔드 Loki를 씁니다.

## 프로덕션 배포

### 1. R2 버킷 + KV 네임스페이스 생성

```bash
wrangler r2 bucket create gateway-error-raw
wrangler kv namespace create CURSOR_KV
```

`wrangler kv namespace create`가 출력한 id를 `wrangler.toml`의 `[[kv_namespaces]]` 블록에
채워 넣습니다.

### 2. Logpush job 생성

Cloudflare 대시보드 → 계정 홈 → **Analytics & Logs → Logpush** → Add a Logpush job:

- Dataset: `gateway_http`
- Destination: 위에서 만든 `gateway-error-raw` R2 버킷
- 필터는 걸지 않는 것을 권장합니다 — `Action != allow`로 걸러버리면 `Action=allow`인데
  업스트림이 5xx를 반환한 케이스(이 Worker가 잡으려는 대상 중 하나)까지 같이 빠집니다.

### 3. Azure VM에 Loki + Grafana 배포

[`../loki-grafana-azure-vm/README.md`](../loki-grafana-azure-vm/README.md)를 먼저 끝까지
진행해서 `https://loki-push.<도메인>/loki/api/v1/push`가 살아있고 Access Service Token으로
보호되는 상태를 만드세요.

### 4. wrangler.toml 값 + 시크릿 설정

`wrangler.toml`의 `LOKI_URL`을 3단계에서 만든 실제 push URL로 바꾸고:

```bash
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
wrangler secret put RUN_TOKEN        # 선택: POST /run?token=... 수동 트리거를 프로덕션에서도 열어두고 싶다면
```

### 5. 배포

```bash
npm run deploy
```

배포 후 `wrangler tail`로 cron 실행 로그(`gateway-error-pipeline run {...}`)를 확인하세요.
`errorsFound`는 늘어나는데 Grafana에 안 뜨면 `wrangler tail`에서 `pushToLoki` 관련 에러(401/403
등)가 있는지 먼저 확인하세요 — Access Service Token 설정 문제인 경우가 대부분입니다.

## 필드 검증 (중요)

`src/filter.ts`의 `extractError`는 Cloudflare 공식 `gateway_http` 스키마 기준 필드명
(`Action`, `HTTPStatusCode`, `PolicyID`, `PolicyName`, `HTTPHost`, `URL`, `Email` 등)을
쓰지만, 계정/플랜에 따라 일부 필드가 비어 있거나 이름이 다를 수 있습니다. 실 트래픽이 쌓인 뒤:

1. Grafana Explore에서 `{job="gateway_http_errors"} | json` 쿼리로 실제 필드명/값을
   확인하세요 (로그 라인에 `raw`로 원본 전체가 같이 실려 있습니다).
2. `errorsFound`가 계속 0이면, R2에 오브젝트가 제대로 도착하는지(`wrangler r2 object list
   gateway-error-raw`) 먼저 확인한 뒤 `extractError`의 필드명을 실제 값에 맞게 조정하세요.

## Grafana 대시보드 확장 아이디어

- 임계치 알림: Grafana Alerting에서 `sum(count_over_time({job="gateway_http_errors"}[5m])) >
  N` 같은 규칙을 만들어 Slack/이메일로 알림
- Access 정책 차단까지 보고 싶다면 `access_requests` Logpush 데이터셋을 같은 R2 버킷에 다른
  prefix로 흘려보내고, `src/ingest.ts`에 소스 판별 로직을 하나 추가하면 됩니다.
