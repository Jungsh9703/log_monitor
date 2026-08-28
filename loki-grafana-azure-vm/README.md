# Loki + Grafana on an Azure Ubuntu VM

`gateway-log-pipeline`(Cloudflare Worker)이 보낸 로그를 받는 Loki + 그걸 보는 Grafana를,
Azure Ubuntu VM에 **네이티브 systemd 서비스**로(컨테이너 없이) 띄우는 구성입니다. 도메인이 없어도
되도록 Cloudflare Tunnel/Access는 쓰지 않고, VM이 이미 공인 IP를 가진 상태라는 전제로 두 서비스를
서로 다른 포트에 직접 노출합니다.

```
Worker (Cloudflare) ──HTTP + Basic Auth──▶ VM 공인 IP:3100 ──▶ nginx ──▶ Loki (127.0.0.1:3101)
                                                                            │
                                                                storage_config.azure
                                                                            ▼
                                                                   Azure Blob Storage
                                                                   (청크 + 인덱스)

브라우저 ──HTTP──▶ VM 공인 IP:3000 ──▶ Grafana (Loki를 127.0.0.1:3101로 직접 조회)
```

- **포트 3100** (Loki push): nginx가 Basic Auth로 막고 내부의 Loki(127.0.0.1:3101, 외부에서
  직접 접근 불가)로 프록시합니다. Loki 자체엔 인증 기능이 없어서 nginx가 유일한 방어선입니다.
- **포트 3000** (Grafana): Grafana 자체 로그인으로 보호되어 공인 IP에 바로 노출됩니다.

## 보안에 대해 미리 말씀드릴 것

지금 구성은 **TLS 없이 평문 HTTP**입니다 — 도메인이 없어서 정식 인증서를 받기 어려운 상태를
감안한 "일단 돌아가게" 구성입니다. 즉 Basic Auth 자격증명과 로그 내용이 암호화 없이 오갑니다.
당장 문제되진 않지만, 나중에 강화하고 싶다면:

- **Azure NSG에서 3100 포트의 인바운드 소스를 `0.0.0.0/0` 대신 Cloudflare의 공개 IP
  대역**(https://www.cloudflare.com/ips/)**으로 제한** — Worker만 두드릴 수 있으면 되므로, 이것만
  해도 노출 범위가 크게 줄어듭니다. (3000/Grafana는 사람이 아무 데서나 접속해야 하므로 이 방식이
  잘 안 맞습니다.)
- 나중에 도메인을 하나 마련하게 되면 [nip.io](https://nip.io) 같은 걸 안 쓰고도 정식 도메인
  기준으로 nginx에 Let's Encrypt(certbot)를 붙여 양쪽 다 HTTPS로 바꿀 수 있습니다.
- Grafana는 설치 직후 기본 비밀번호(`admin`/`admin`)이므로 **반드시** 바로 바꾸세요 (아래 3단계).

## 사전 준비

- Ubuntu 22.04/24.04 Azure VM (이미 공인 IP로 배포되어 있다고 하셨으니 그대로 사용)
- Azure Storage 계정 + 컨테이너 (Loki 백엔드용)

## 1. Azure Storage 계정 + 컨테이너 생성 (Loki 백엔드)

이 명령어들은 VM 안이 아니라 **Azure CLI(`az`)가 설치된 아무 곳**에서 실행합니다 — Azure
Cloud Shell(portal.azure.com 상단의 `>_` 아이콘, 설치 불필요) 또는 로컬 PC.

Bash / Cloud Shell(기본이 Bash):

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

Windows PowerShell (변수 대입 문법이 다릅니다 — `VAR=$(...)`가 아니라 `$VAR = (...)`):

```powershell
az group create --name gateway-logs-rg --location koreacentral

az storage account create `
  --name <원하는-고유이름> `
  --resource-group gateway-logs-rg `
  --sku Standard_LRS `
  --kind StorageV2

$ACCOUNT_KEY = (az storage account keys list `
  --account-name <원하는-고유이름> `
  --resource-group gateway-logs-rg `
  --query "[0].value" -o tsv)

az storage container create `
  --name loki-data `
  --account-name <원하는-고유이름> `
  --account-key "$ACCOUNT_KEY"
```

## 2. VM에 SSH로 들어가서 저장소 clone

저장소가 GitHub에 공개되어 있으므로, 로컬에서 `scp`로 파일을 옮길 필요 없이 VM 안에서 바로
받으면 됩니다 (Azure Cloud Shell에서 `ssh`로 들어가도 되고, 어디서 접속하든 상관없습니다).

```bash
ssh azureuser@<VM_PUBLIC_IP>
sudo apt-get install -y git   # 이미 있으면 생략됨
git clone https://github.com/Jungsh9703/log_monitor.git
cd log_monitor/loki-grafana-azure-vm
```

## 3. 설치 스크립트 실행

```bash
sudo ./install.sh
```

apt 저장소 등록, `grafana`/`loki`/`nginx` 설치, 설정 파일 배치, systemd override, nginx 사이트
등록까지 자동으로 합니다. 끝나면 아래 수동 단계를 안내하는 메시지가 출력됩니다.

### 3-1. Loki에 Azure 자격증명 넣고 시작

```bash
sudo vi /etc/loki/loki.env
```
```ini
AZURE_STORAGE_ACCOUNT_NAME=<1단계에서 만든 이름>
AZURE_STORAGE_ACCOUNT_KEY=<1단계의 $ACCOUNT_KEY>
AZURE_STORAGE_CONTAINER_NAME=loki-data
```
```bash
sudo systemctl enable --now loki
sudo systemctl status loki   # Azure 인증 에러 없이 떴는지 확인
```

### 3-2. nginx Basic Auth 계정 생성

```bash
sudo htpasswd -c /etc/nginx/.htpasswd loki-pusher
sudo systemctl reload nginx
```
여기서 정한 사용자명/비밀번호가 나중에 `gateway-log-pipeline`의 `LOKI_USERNAME`/`LOKI_API_KEY`
시크릿 값이 됩니다.

### 3-3. Grafana 시작 + 기본 비밀번호 변경

```bash
sudo systemctl enable --now grafana-server
sudo grafana-cli admin reset-admin-password '<강력한-비밀번호>'
```

## 4. Azure NSG 인바운드 규칙

Azure Portal → VM → Networking → 인바운드 포트 규칙 추가:

- TCP 3100 (Loki push) — 소스를 Cloudflare IP 대역으로 제한하는 걸 권장(위 "보안" 절 참고),
  당장 급하면 Any로 시작해도 무방
- TCP 3000 (Grafana UI) — Any (브라우저로 아무 데서나 접속해야 하므로)

## 5. 확인

```bash
curl -u loki-pusher:<3-2에서 정한 비밀번호> http://<VM_PUBLIC_IP>:3100/ready
# -> "ready"
```

브라우저로 `http://<VM_PUBLIC_IP>:3000` 접속 → 방금 바꾼 admin 비밀번호로 로그인 → 좌측
Dashboards에 **Gateway HTTP Logs (All Traffic)** / **Gateway HTTP Errors**가 프로비저닝되어
있어야 합니다 (아직 데이터는 없는 게 정상 — Worker가 뭔가 보내야 채워집니다).

## 6. Worker 쪽 연결

`../gateway-log-pipeline/wrangler.toml`의 `LOKI_URL`/`LOKI_USERNAME`(둘 다 평문 변수)을
바꾸고 비밀번호만 시크릿으로 등록합니다. **`LOKI_URL`은 IP를 그대로 쓰면 안 됩니다** —
Cloudflare Worker의 `fetch()`가 IP-literal URL을 Cloudflare 엣지로 라우팅하다가 "error code:
1003"으로 막혀서 VM까지 아예 못 갑니다. 도메인이 없으니 무료 퍼블릭 DNS인
[nip.io](https://nip.io)로 우회합니다 (`<IP>.nip.io`가 그 IP로 그대로 resolve됨 — VM의
nginx는 Host 헤더를 안 보니 추가 설정 불필요):

```toml
LOKI_URL = "http://<VM_PUBLIC_IP>.nip.io:3100/loki/api/v1/push"
LOKI_USERNAME = "loki-pusher"   # 3-2에서 만든 사용자명
```

```bash
cd ../gateway-log-pipeline
wrangler secret put LOKI_API_KEY      # 3-2에서 만든 비밀번호
npm run deploy
```

Cloudflare Access를 안 쓰므로 `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`은 비워두면
됩니다 (`src/loki.ts`가 두 세트를 다 지원하고, 설정 안 된 쪽은 그냥 헤더를 안 붙입니다).

`wrangler tail`로 cron 실행 로그를 보면서 `pushToLoki` 관련 에러(401 등)가 없는지 확인하세요.

## 트러블슈팅

- `systemctl status loki`에 Azure 인증 에러가 뜨면 `/etc/loki/loki.env` 값을 다시 확인하고
  `sudo systemctl restart loki`.
- `curl .../ready`가 401이면 nginx Basic Auth 자격증명이 Worker 시크릿과 다른 것 — 3-2에서
  만든 값과 `wrangler secret`으로 넣은 값이 정확히 같은지 확인하세요.
- Grafana 대시보드에 패널은 있는데 데이터가 안 뜨면: Worker의 `wrangler tail`로 cron이 실제로
  도는지, `errorsFound`/`recordsShipped`가 0보다 큰지 먼저 확인하세요.
- 재부팅 후에도 로그가 남아 있어야 하는 이유가 Azure Blob 백엔드입니다 — `/var/lib/loki`는
  캐시일 뿐이고, 실제 청크/인덱스는 Azure Blob 컨테이너(`loki-data`)에 있습니다.
  `az storage blob list --container-name loki-data --account-name <이름> --account-key "$ACCOUNT_KEY"`
  로 실제 오브젝트가 쌓이는지 확인할 수 있습니다.
