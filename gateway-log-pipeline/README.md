# Gateway Log Pipeline

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jungsh9703/log_monitor/tree/main/gateway-log-pipeline)

버튼을 누르면 Cloudflare가 이 서브디렉터리를 읽어 R2 버킷을 자동 생성하고(Durable Object는
별도 리소스 생성 없이 배포에 포함된 마이그레이션으로 처리됩니다) `wrangler deploy`까지
진행합니다. 진행 중 화면에서 `LOKI_URL`/`LOKI_USERNAME`(둘 다 평문 변수)과
`.dev.vars.example`의 시크릿(`LOKI_API_KEY` — `loki-grafana-azure-vm`의 nginx Basic Auth
비밀번호, 또는 도메인이 있어서 Cloudflare Access를 쓴다면 `CF_ACCESS_CLIENT_ID` 등)을
입력하라고 물어봅니다 — 이 필드들 중 진짜 필수인 건 없으니, 아직 `loki-grafana-azure-vm`을 안
띄우셨다면 전부 빈 값/기본값으로 두고 넘어가도 배포 자체는 됩니다(Loki push만 나중에 안 될
뿐). 버튼이 대신해주지 않는 것: **Logpush job 생성**(Cloudflare 대시보드에서 직접),
**`LOKI_URL` 값 갱신**과 **시크릿 재설정**(Loki가 준비된 후 Cloudflare 대시보드의 Worker →
Settings → Variables and Secrets, 또는 `wrangler secret put ...`으로).

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
먼저 진행해서 `http://<VM_PUBLIC_IP>.nip.io:3100/loki/api/v1/push`와 nginx Basic Auth
계정을 확보하세요 (`gateway-error-pipeline`과 같은 Loki 인스턴스를 공유해도 됩니다 — job
라벨이 달라서 Grafana에서 구분됩니다). **`.nip.io`를 꼭 붙이세요** — Cloudflare Worker의
`fetch()`는 URL이 IP 주소 그대로면 Cloudflare 엣지가 가로채서 자체 "error code: 1003"을
반환하고 VM까지 아예 도달하지 못합니다. nip.io는 IP를 그대로 도메인처럼 쓰게 해주는 무료
퍼블릭 DNS라 이 문제를 우회합니다 (VM의 nginx는 Host 헤더를 안 보므로 별도 설정 불필요).

### 4. wrangler.toml 값 + 시크릿 설정

`wrangler.toml`의 `LOKI_URL`/`LOKI_USERNAME`(둘 다 평문 변수)을 3단계에서 만든 주소/계정으로
바꾸고, 비밀번호만 시크릿으로 등록합니다:

```bash
wrangler secret put LOKI_API_KEY      # nginx Basic Auth 계정의 비밀번호
wrangler secret put RUN_TOKEN         # 선택
```

(도메인을 마련해서 Cloudflare Tunnel + Access로 바꾸는 경우에만 대신 `CF_ACCESS_CLIENT_ID`/
`CF_ACCESS_CLIENT_SECRET`을 씁니다 — `src/loki.ts`가 둘 다 지원합니다.)

**선택: Gateway 정책 이름 표시** — `gateway_http` 로그에는 정책 ID(`rule_id`)만 있고 이름
필드 자체가 없어서, Cloudflare API로 ID→이름을 조회해서 채워주는 기능이 있습니다. 안 하면
Grafana에 정책 이름 대신 UUID가 표시될 뿐, 다른 기능에는 지장 없습니다.

1. Cloudflare 대시보드 → 우측 상단 프로필 → **My Profile → API Tokens → Create Token** →
   Custom token → Permissions: **Account → Zero Trust → Read**
2. 계정 ID는 대시보드 우측 사이드바 또는 `wrangler whoami`로 확인
3. ```bash
   wrangler secret put CF_API_TOKEN
   ```
   그리고 `wrangler.toml`의 `CF_ACCOUNT_ID`를 채우기

30분 캐시(Durable Object에 저장)로 API를 매 cron마다 호출하지 않도록 했습니다.

**선택: DLP 프로필/엔트리 이름 표시** — `*_matched_dlp_profiles`/`*_matched_dlp_profileEntries`도
정책 ID와 마찬가지로 UUID뿐이라(Cloudflare Zero Trust UI에서는 "카드번호_DLP" 같은 이름으로
보이는 그 값), 같은 방식으로 `/accounts/{id}/dlp/profiles` API를 조회해서 채워줍니다. 위
`CF_ACCOUNT_ID`/`CF_API_TOKEN`을 이미 설정했다면 추가 설정 없이 같이 동작합니다 — 토큰
권한이 부족하면(DLP 프로필 조회가 별도 권한일 수 있음) 이 부분만 조용히 실패하고 원본 UUID로
표시되니, 이름이 안 뜨면 토큰에 **Account → DLP → Read** 권한을 추가해보세요.

이 API의 개별 엔트리(프로필 안의 세부 탐지 규칙) 이름 필드 구조는 Cloudflare 문서에서 완전한
예시를 못 찾아서 추정으로 짜놨습니다(`src/dlp_profile_names.ts`) — 프로필 이름은 뜨는데 엔트리
이름이 안 뜨면 알려주시면 실제 API 응답 보고 고치겠습니다.

**선택: GenAI prompt / DLP 매치 내용 복호화** — Gateway HTTP 정책의 "Capture generative AI
prompt content in logs"나 DLP 정책이 매치됐을 때, `gateway_http` 로그에는 해당 내용이 HPKE로
암호화된 채로 실립니다(`gen_ai_prompt_request`/`response`/`conversation`,
`dlp_match_context_parsed.p`). Zero Trust 대시보드의 "Decrypt payload log" 버튼과 똑같은
방식(로컬에서 private key로 복호화)으로, 이 Worker가 대신 복호화해서 Grafana에서 바로 볼 수
있게 해주는 기능입니다 (`../workers`(AI Prompt Log Dashboard) 프로젝트와 같은 방식 재사용).

이미 DLP Payload Encryption 키 페어를 만들어두셨다면:

```bash
wrangler secret put DLP_PRIVATE_KEY   # 그때 저장해둔 base64 private key
```

**주의**: private key를 잃어버렸거나 아직 키 페어가 없다면, Zero Trust 대시보드 → **Settings
→ DLP → DLP Payload Encryption public key**에서 새로 생성해야 하는데, **이전에 캡처된 로그는
새 키로 복호화가 안 됩니다** (키를 바꾸기 전 데이터는 옛날 키로만 풀림). 설정 안 해도 나머지
기능엔 지장 없고, 암호화된 원본 블롭은 `raw` 필드에 그대로 남아있어서 나중에 언제든 복호화할
수 있습니다.

1분마다 도는 cron 특성상, 한 번에 매치되는 줄이 몰리면(예: DLP 정책이 대량으로 걸리는 순간)
`MAX_DECRYPTIONS_PER_RUN`(기본 20) 초과분은 이번 실행에서는 건너뜁니다 — 데이터가 사라지는 건
아니고, 암호화된 원본은 여전히 Loki에 저장되니 나중에 필요하면 다른 방식으로 복호화할 수
있습니다.

### 5. 배포

```bash
npm run deploy
```

`wrangler tail`로 `recordsShipped`가 늘어나는지, `pushToLoki` 관련 에러(401/403, 요청 크기
초과 등)가 없는지 확인하세요.

## 필드 검증 (중요)

`src/normalize.ts`의 필드명은 **snake_case**입니다 (`datetime`, `action_name`, `http_host`,
`http_status_code`, `http_method_name`, `rule_id`, `email`, `user_id` 등) — Cloudflare
공식 문서에 나오는 PascalCase(`Action`, `HTTPHost` 등)와는 다른 표기입니다. 이 계정의 실제
Zero Trust 대시보드 → **Logs → HTTP request logs**에서 로그 하나를 펼쳐 **JSON** 탭으로
확인한 실제 필드명 기준으로 맞춘 것입니다. `action`/`http_method`는 숫자 코드이고
`action_name`/`http_method_name`이 실제로 쓰는 문자열 필드입니다.

계정/플랜에 따라 필드가 다를 수 있으니, Grafana Explore에서
`{job="gateway_http_logs"} | json`으로 실제 값을 확인하세요 (로그 라인에 `raw`로 원본 전체가
같이 실려 있습니다).
