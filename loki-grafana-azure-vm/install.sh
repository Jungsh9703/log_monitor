#!/usr/bin/env bash
# Installs Loki + Grafana natively (systemd, no containers) on Ubuntu, and
# nginx as the Basic-Auth front for Loki's push endpoint. Run as root (or
# via sudo) on the Azure VM, from within this directory (the repo files
# referenced below -- loki-config.yml, systemd/, nginx/, grafana/ -- must be
# present in the current directory, e.g. after `git clone` or `scp -r`).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo ./install.sh" >&2
  exit 1
fi

echo "==> Adding the Grafana Labs apt repository (covers grafana + loki)"
apt-get update -y
apt-get install -y gpg curl apache2-utils nginx
mkdir -p /etc/apt/keyrings
curl -fsSL https://apt.grafana.com/gpg-full.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  > /etc/apt/sources.list.d/grafana.list
apt-get update -y

echo "==> Installing grafana + loki"
apt-get install -y grafana loki

echo "==> Writing Loki config"
install -m 644 loki-config.yml /etc/loki/config.yml
mkdir -p /var/lib/loki/boltdb-shipper-active /var/lib/loki/boltdb-shipper-cache /var/lib/loki/compactor
chown -R loki:loki /var/lib/loki

if [ ! -f /etc/loki/loki.env ]; then
  install -m 600 loki.env.example /etc/loki/loki.env
  echo "    Created /etc/loki/loki.env -- fill in your Azure Storage account name/key before starting Loki."
fi

echo "==> Installing systemd override for Loki (env expansion)"
mkdir -p /etc/systemd/system/loki.service.d
install -m 644 systemd/loki-override.conf /etc/systemd/system/loki.service.d/override.conf
systemctl daemon-reload

echo "==> Writing Grafana provisioning"
cp -r grafana/provisioning/. /etc/grafana/provisioning/
mkdir -p /etc/grafana/dashboards
cp grafana/dashboards/*.json /etc/grafana/dashboards/
chown -R grafana:grafana /etc/grafana/provisioning /etc/grafana/dashboards

echo "==> Installing nginx site for Loki's Basic-Auth-protected push endpoint"
cp nginx/loki-proxy.conf /etc/nginx/sites-available/loki-proxy.conf
ln -sf /etc/nginx/sites-available/loki-proxy.conf /etc/nginx/sites-enabled/loki-proxy.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t

cat <<'EOF'

==> Remaining manual steps:
  1. Fill in /etc/loki/loki.env (Azure Storage account name/key), then:
       systemctl enable --now loki
  2. Create the nginx Basic Auth user (pick your own username):
       htpasswd -c /etc/nginx/.htpasswd loki-pusher
       systemctl reload nginx
  3. Enable Grafana and set a real admin password (default is admin/admin):
       systemctl enable --now grafana-server
       grafana-cli admin reset-admin-password '<a-strong-password>'
  4. In the Azure Portal, open inbound NSG rules for:
       - TCP 3100 (Loki push, via nginx) -- ideally restricted to Cloudflare's
         published IP ranges (https://www.cloudflare.com/ips/), since only
         the Worker needs to reach it
       - TCP 3000 (Grafana UI)
  5. Verify:
       curl -u loki-pusher:<password> http://<vm-public-ip>:3100/ready
       -> should return "ready"
       open http://<vm-public-ip>:3000 in a browser -> Grafana login

See README.md for the full walkthrough and the gateway-log-pipeline side.
EOF
