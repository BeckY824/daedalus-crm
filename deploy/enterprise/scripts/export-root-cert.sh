#!/usr/bin/env bash
# 导出 Caddy 内部 CA 的根证书，装到员工电脑上，浏览器就不再提示「不安全 / 证书不受信任」。
# 只在用 IP 访问（或手动写了 tls internal）时需要；用域名自动申请、或用贵司自己的证书时不需要。
#
#   sudo ./scripts/export-root-cert.sh [输出文件，默认 ./crm-root-ca.crt]
#
# 导出的是公开的根证书（不含私钥），可以发给员工。各系统怎么装见部署手册「四、HTTPS 证书」。
# 注意：caddy-data 数据卷没了（换服务器、docker compose down -v）会生成新的根证书，员工要重新装。
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need_docker

OUT="${1:-$DEPLOY_DIR/crm-root-ca.crt}"
case "$OUT" in /*) ;; *) OUT="$OLDPWD/$OUT" ;; esac

if [ "$(tls_mode)" != internal ]; then
  ok "现在用的不是内部 CA 证书（$(tls_mode)），浏览器本来就信任，不用导出"
  exit 0
fi
[ "$(docker compose ps --status running -q caddy 2>/dev/null)" != "" ] || die "caddy 没在运行（docker compose up -d 启动）"

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
# 根证书在第一次签发时生成；刚装完可能还没生成，等一会儿
for _ in $(seq 1 20); do
  if docker compose exec -T caddy cat "$CADDY_ROOT_CRT" > "$TMP" 2>/dev/null && [ -s "$TMP" ]; then break; fi
  sleep 3
done
openssl x509 -in "$TMP" -noout >/dev/null 2>&1 || die "从 caddy 容器读不到根证书 ${CADDY_ROOT_CRT}（先用浏览器打开一次 https://$(env_get DOMAIN) 再试）"
install -m 644 "$TMP" "$OUT"

ok "根证书已导出：$OUT"
echo "  名称：$(openssl x509 -in "$OUT" -noout -subject | sed 's/^subject= *//')"
echo "  有效期至：$(openssl x509 -in "$OUT" -noout -enddate | cut -d= -f2)"
echo "  SHA-256 指纹：$(openssl x509 -in "$OUT" -noout -fingerprint -sha256 | cut -d= -f2)"
echo "  发给员工时把指纹一起发，装之前核对一致，防止被人换掉。"
