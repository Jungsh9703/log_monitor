# Loki + Grafana on an Azure Ubuntu VM

`gateway-error-pipeline`(Cloudflare Worker)이 필터링한 Gateway HTTP 에러를 받아서, Azure Blob
Storage를 저장 백엔드로 쓰는 Loki + 그걸 시각화하는 Grafana를 Azure Ubuntu VM 위에 띄우는
스택입니다.

```
Worker (Cloudflare) ──HTTPS(Loki push API)──▶ Cloudflare Tunnel ──▶ 이 VM
                                                                      │
                                                        ┌─────────────┴─────────────┐
                                                        │  loki (컨테이너)           │
                                                        │  storage_config.azure  ───┼──▶ Azure Blob Storage
                                                        │  grafana (컨테이너)        │      (청크 + 인덱스)
                                                        │  cloudflared (컨테이너)    │
                                                        └───────────────────────────┘
                                                                      │
                                                     브라우저 ──HTTPS── Cloudflare Tunnel
                                                     (Grafana 대시보드)
```

VM에는 **인바운드 포트를 하나도 열지 않습니다.** `cloudflared`가 Cloudflare로 아웃바운드
연결만 유지하고, Loki push 엔드포인트와 Grafana UI 둘 다 Cloudflare Tunnel의 Public Hostname을
통해서만 도달 가능합니다. Loki push는 **Cloudflare Access Service Token**으로, Grafana UI는
**Access의 사용자 로그인 정책**으로 각각 보호합니다.

## 1. Azure Storage 계정 + 컨테이너 생성 (Loki 백엔드)

```bash
az group create --name gateway-logs-rg --location koreacentral

az storage account create \
  --name <원하는-고유이름> \
  --resource-group gateway-logs-rg \
  --sku Standard_LRS \
  --kind StorageV2

ACCOUNT_KEY=$(az storage account keys list \
  --account-name <원하는-고유이름> \
  --resource-group gateway-logs-rg \
  --query "[0].value" -o tsv)

az storage container create \
  --name loki-data \
  --account-name <원하는-고유이름> \
  --account-key "$ACCOUNT_KEY"
```

계정 이름과 `$ACCOUNT_KEY`를 아래 4단계의 `.env`에 넣습니다.

## 2. Ubuntu VM 생성 + Docker 설치

```bash
az vm create \
  --resource-group gateway-logs-rg \
  --name gateway-logs-vm \
  --image Ubuntu2404 \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys

ssh azureuser@<VM_PUBLIC_IP>
```

VM 안에서:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

이 디렉터리(`loki-grafana-azure-vm/`) 전체를 VM으로 복사합니다 (`scp -r` 또는 git clone).

## 3. Cloudflare Tunnel + Access 설정 (Zero Trust 대시보드)

이미 Zero Trust를 쓰고 계시니 대시보드에서 그대로 진행하면 됩니다.

1. **Networks → Tunnels → Create a tunnel** → Cloudflared → 이름 지정 (예: `gateway-logs-vm`)
2. 환경 선택에서 **Docker** 선택 → 표시되는 토큰(`TUNNEL_TOKEN=...`)을 복사 (아래 4단계 `.env`용)
3. **Public Hostname** 두 개 추가:
   - `loki-push.<도메인>` → Service: `HTTP` → URL: `loki:3100`
   - `grafana.<도메인>` → Service: `HTTP` → URL: `grafana:3000`
   (컨테이너끼리는 같은 docker compose 네트워크 안에서 서비스 이름으로 통신하므로 `localhost`가
   아니라 `loki`/`grafana`를 씁니다.)
4. **Access → Applications → Add an application → Self-hosted**
   - `grafana.<도메인>` 용: 정책에 본인 이메일(또는 기존 Zero Trust ID 프로바이더)만 허용 —
     브라우저로 로그인할 사람만 통과
   - `loki-push.<도메인>` 용: 정책 타입을 **Service Auth**로 만들고 **Service Token** 발급 →
     여기서 나온 **Client ID / Client Secret**을 나중에 `gateway-error-pipeline`의
     `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` 시크릿으로 사용

## 4. `.env` 채우고 배포

```bash
cp .env.example .env
# AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY, TUNNEL_TOKEN, DOMAIN 채우기

docker compose up -d
docker compose logs -f loki   # Azure Blob 연결 에러 없이 뜨는지 확인
```

## 5. 확인

- `https://grafana.<도메인>` 접속 → Access 로그인 → 좌측 Dashboards → **Gateway HTTP Errors**
  대시보드가 프로비저닝되어 있어야 합니다 (아직 데이터는 없는 게 정상 — Worker가 뭔가 보내야
  채워집니다).
- Loki push 엔드포인트가 인증 없이는 막혀 있는지 확인:
  ```bash
  curl -i https://loki-push.<도메인>/ready
  ```
  Cloudflare Access가 앞에 있으므로 인증 헤더 없이는 302(로그인 리다이렉트) 또는 403이 떠야
  정상입니다.

## 6. Worker 쪽 연결

`../gateway-error-pipeline/wrangler.toml`의 `LOKI_URL`을
`https://loki-push.<도메인>/loki/api/v1/push`로 바꾸고, 시크릿을 설정합니다:

```bash
cd ../gateway-error-pipeline
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
npm run deploy
```

이제 실제 Cloudflare Logpush job(`gateway_http` → `gateway-error-raw` R2 버킷)까지 만들어지면,
5분 cron마다 에러가 이 VM의 Loki로 들어오고 Grafana 대시보드에 반영됩니다.

## 트러블슈팅

- `docker compose logs loki`에 Azure 인증 에러가 뜨면 `.env`의 계정 이름/키를 다시 확인하세요.
- Grafana 대시보드에 패널은 있는데 데이터가 안 뜨면: Worker의 `wrangler tail`로 cron 실행 로그
  확인 → `pushToLoki` 단계에서 401/403이 뜨면 Access Service Token이 잘못 설정된 것입니다.
- 컨테이너 재시작 후에도 기존 로그가 남아 있어야 하는 이유가 바로 Azure Blob 백엔드입니다 —
  `loki-scratch` 볼륨은 캐시일 뿐이고, 실제 청크/인덱스는 Azure Blob 컨테이너(`loki-data`)에
  있습니다. `az storage blob list --container-name loki-data --account-name <이름> --account-key "$ACCOUNT_KEY"`
  로 실제 오브젝트가 쌓이는지 확인할 수 있습니다.
