# Gateway Log Pipeline

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jungsh9703/log_monitor/tree/main/gateway-log-pipeline)

버튼을 누르면 Cloudflare가 이 서브디렉터리를 읽어 R2 버킷을 자동 생성하고(Durable Object는
별도 리소스 생성 없이 배포에 포함된 마이그레이션으로 처리됩니다) `wrangler deploy`까지
진행합니다. 진행 중 화면에서 `.dev.vars.example`에 있는 시크릿(`LOKI_USERNAME`/`LOKI_API_KEY`
— `loki-grafana-azure-vm`의 nginx Basic Auth 계정, 또는 도메인이 있어서 Cloudflare Access를
쓴다면 `CF_ACCESS_CLIENT_ID` 등)을 입력하라고 물어봅니다 — 아직 `loki-grafana-azure-vm`을 안
띄우셨다면 전부 빈 값으로 두고 넘어가도 배포 자체는 됩니다(Loki push만 나중에 안 될 뿐). 버튼이
대신해주지 않는 것: **Logpush job 생성**(Cloudflare 대시보드에서 직접), **`LOKI_URL` 값
갱신**과 **시크릿 재설정**(Loki가 준비된 후 `wrangler secret put ...`으로).

`gateway-error-pipeline`은 에러(정책 차단 + 4xx/5xx)만 골라 보냈지만, 이 프로젝트는 **Zero
Trust Gateway HTTP 로그 전체**를 필터링 없이 Grafana로 보냅니다. 전체 트래픽을 바탕으로 대시보드를
구성하려는 목적이라 `gateway-error-pipeline`은 당분간 사용하지 않습니다 (코드는 남겨둠).

```
Zero Trust Gateway HTTP 트래픽 (전체)
        │
        ▼
Logpush job (dataset: gateway_http) ─────────▶ R2 bucket (raw gzip NDJSON)
                                                        │
                                          Worker cron (1분, 커서로 이어서 처리)
                                          1) gunzip + NDJSON 파싱
                                          2) 필터링 없이 모든 라인을 정규화
                                          3) 정규화된 레코드(+원본 전체) → Loki push (청크 분할)
                                                        │
                                                        ▼
                                   Loki (Azure Ubuntu VM, storage_config.azure)
                                   → 청크/인덱스는 Azure Blob Storage에 저장
                                                        │
                                                        ▼
                                              Grafana Dashboard
```

Loki + Grafana를 실제로 띄우는 Azure VM 스택은 [`../loki-grafana-azure-vm`](../loki-grafana-azure-vm)
에 있습니다 (`gateway-error-pipeline`과 공유). 그쪽 Grafana에는 이 프로젝트의 대시보드
(`Gateway HTTP Logs (All Traffic)`)와 error-pipeline용 대시보드가 둘 다 프로비저닝되어
있습니다.

## `gateway-error-pipeline`과 다른 점

| | gateway-error-pipeline | gateway-log-pipeline (이 프로젝트) |
|---|---|---|
| 대상 | 에러만 (`Action!=allow` 또는 `HTTPStatusCode>=400`) | 전체 트래픽 |
| R2 버킷 | `gateway-error-raw` | `gateway-log-raw` (별도 Logpush job 필요) |
| Loki job 라벨 | `gateway_http_errors` | `gateway_http_logs` |
| 볼륨/비용 | 낮음 | **훨씬 높음** — 전체 트래픽만큼 Loki/Azure Blob에 저장됨 |
| Loki push | 1회 push | 500건 단위로 청크 분할 push (배치가 커서 한 번에 보내면 요청 크기 제한에 걸릴 수 있음) |

두 파이프라인은 R2 버킷을 분리해서 서로 간섭하지 않습니다. 나중에 `gateway-error-pipeline`을
다시 쓰고 싶다면 그냥 그 Worker를 별도로 배포하면 됩니다 (둘 다 동시에 떠 있어도 무방). 참고로
`gateway-error-pipeline`은 아직 커서 저장소로 Workers KV를 쓰고 5분 주기입니다 — 이 프로젝트만
아래 이유로 Durable Object + 1분 주기로 바꿨습니다.

## 왜 Workers KV 대신 Durable Object인가

커서 상태(어떤 R2 오브젝트를 어디까지 처리했는지)를 Workers KV에 저장하면, KV는 **최종적
일관성**(eventually consistent) 모델이라 한 번 쓴 값이 전 세계 엣지에 전파되는 데 최대 60초
정도 걸릴 수 있습니다. cron이 5분 간격이면 문제가 안 되지만, **1분 간격**으로 줄이면 직전 실행이
KV에 쓴 커서를 다음 실행이 아직 전파 안 된 오래된 값으로 읽어서 이미 처리한 오브젝트를 중복
처리하거나 커서가 꼬일 위험이 생깁니다.

Durable Object(`src/cursor_do.ts`의 `IngestCursor`)는 전역에 단 하나의 인스턴스만 존재하고
모든 읽기/쓰기가 그 인스턴스를 강한 일관성으로 통과하기 때문에 이 문제가 없습니다. Cloudflare
대시보드에서는 KV/R2/D1처럼 "Storage & Databases"의 별도 상품이 아니라 **Compute → Workers &
Pages**에 속한 Worker 코드의 일부로 배포됩니다 — `wrangler.toml`의 `durable_objects.bindings` +
`migrations`가 그 역할을 하고, 별도로 리소스를 만들 필요가 없습니다. SQLite 저장 백엔드를 쓰는
Durable Object는 Workers **Free 플랜**에서도 동작합니다(예전 저장 백엔드는 유료 플랜 전용이었지만,
현재는 SQLite 백엔드가 기본이자 무료 플랜 지원 대상입니다 — 배포 시점의 Cloudflare 요금제 페이지로
한 번 더 확인하는 걸 권장합니다).

## 볼륨/비용 주의

전체 로그를 다 보내므로 트래픽이 많은 계정이면 R2 저장량, Loki 처리량, Azure Blob 저장량이
빠르게 늘어날 수 있습니다.

- `wrangler.toml`의 `MAX_OBJECTS_PER_RUN`/`MAX_LINES_PER_OBJECT_RUN`을 실제 트래픽에 맞게
  낮추세요 (기본값은 1분마다 최대 5개 오브젝트 × 2000줄 = 10,000줄 — 5분 주기였을 때와 같은
  값을 그대로 뒀으니, 실제로는 분당 처리량이 5배 늘어난 셈입니다. 트래픽이 많다면 값을 낮춰서
  시작하세요).
- Loki 쪽 리텐션(`limits_config.retention_period` 등)을 설정해 오래된 로그를 자동 삭제하는
  것도 고려하세요 — `../loki-grafana-azure-vm/loki-config.yaml`에는 기본값이 없으니 필요하면
  추가하세요.
- 정말 전체가 필요한 게 아니라 특정 조건(예: 특정 정책, 특정 호스트)만 필요하다면 Logpush job
  자체에 필터를 걸어 R2에 도착하는 양부터 줄이는 것도 방법입니다.

## 로컬 동작 확인 (Loki 없이 파싱만)

```bash
npm install
npm run dev
```

다른 터미널에서:

```bash
npm run seed:local
curl -X POST http://127.0.0.1:8787/run
```

`/run` 응답의 `recordsShipped`가 샘플 줄 수(10)와 같으면 파싱이 정상입니다 — 필터링이 없으므로
모든 줄이 카운트됩니다. `LOKI_URL`이 아직 가짜 값이라 마지막 `pushToLoki` 호출은 실패하는 게
정상입니다.

Loki까지 포함해 로컬로 가볍게 검증하려면 (filesystem 백엔드, Azure 없이):

```bash
docker compose up -d
```

- Grafana: http://localhost:3000 (익명 Admin 접속 허용)
- 좌측 Dashboards → **Gateway HTTP Logs (All Traffic)**

## 프로덕션 배포

### 1. R2 버킷 생성

```bash
wrangler r2 bucket create gateway-log-raw
```

(`gateway-error-pipeline`의 R2 버킷과는 별개로 새로 만드는 것입니다.) 커서 저장용 Durable
Object는 별도로 만들 게 없습니다 — `npm run deploy`가 `wrangler.toml`의 마이그레이션을 보고
알아서 프로비저닝합니다.

### 2. Logpush job 생성

Cloudflare 대시보드 → 계정 홈 → **Analytics & Logs → Logpush** → Add a Logpush job:

- Dataset: `gateway_http`
- Destination: 위에서 만든 `gateway-log-raw` R2 버킷
- 필터: 전체를 보고 싶은 목적이므로 걸지 않습니다.

### 3. Azure VM에 Loki + Grafana 배포

아직 안 했다면 [`../loki-grafana-azure-vm/README.md`](../loki-grafana-azure-vm/README.md)를
먼저 진행해서 `http://<VM_PUBLIC_IP>:3100/loki/api/v1/push`와 nginx Basic Auth 계정을
확보하세요 (`gateway-error-pipeline`과 같은 Loki 인스턴스를 공유해도 됩니다 — job 라벨이
달라서 Grafana에서 구분됩니다).

### 4. wrangler.toml 값 + 시크릿 설정

`wrangler.toml`의 `LOKI_URL`을 3단계에서 만든 주소로 바꾸고:

```bash
wrangler secret put LOKI_USERNAME     # loki-grafana-azure-vm에서 만든 nginx Basic Auth 사용자명
wrangler secret put LOKI_API_KEY      # 같은 계정의 비밀번호
wrangler secret put RUN_TOKEN        # 선택
```

(도메인을 마련해서 Cloudflare Tunnel + Access로 바꾸는 경우에만 대신 `CF_ACCESS_CLIENT_ID`/
`CF_ACCESS_CLIENT_SECRET`을 씁니다 — `src/loki.ts`가 둘 다 지원합니다.)

### 5. 배포

```bash
npm run deploy
```

`wrangler tail`로 `recordsShipped`가 늘어나는지, `pushToLoki` 관련 에러(401/403, 요청 크기
초과 등)가 없는지 확인하세요.

## 필드 검증 (중요)

`src/normalize.ts`의 필드명은 Cloudflare 공식 `gateway_http` 스키마 기준이지만, 계정/플랜에
따라 비어 있거나 다를 수 있습니다. Grafana Explore에서 `{job="gateway_http_logs"} | json`으로
실제 값을 확인하세요 (로그 라인에 `raw`로 원본 전체가 같이 실려 있습니다).
