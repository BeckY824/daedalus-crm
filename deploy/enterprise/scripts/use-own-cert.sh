#!/usr/bin/env bash
# 改用贵司自己的 HTTPS 证书（不用自动申请的 Let's Encrypt 证书时）。
#
#   1. 把证书放进部署目录的 certs/：
#        certs/cert.pem   证书（含中间证书链，一般叫 fullchain）
#        certs/key.pem    私钥
#   2. sudo ./scripts/use-own-cert.sh
#
# 证书续期后：覆盖这两个文件，再执行一次本脚本。
# 改回自动申请：sudo ./scripts/use-own-cert.sh --auto
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# reload 成功时 Caddy 会刷一屏 JSON 日志，只在失败时给人看
caddy_reload() {
  local out
  out="$(docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
}

need_docker

mkdir -p certs
if [ "${1:-}" = "--auto" ]; then
  rm -f certs/tls.caddy
  caddy_reload
  ok "已改回自动申请证书"
  exit 0
fi

[ -s certs/cert.pem ] || die "缺 certs/cert.pem"
[ -s certs/key.pem ]  || die "缺 certs/key.pem"

# 先在本机核对：证书和私钥是不是一对、有没有过期、域名对不对
openssl x509 -in certs/cert.pem -noout >/dev/null 2>&1 || die "certs/cert.pem 不是有效的 PEM 证书"
CERT_PUB="$(openssl x509 -in certs/cert.pem -noout -pubkey 2>/dev/null | openssl sha256)"
KEY_PUB="$(openssl pkey -in certs/key.pem -pubout 2>/dev/null | openssl sha256)" || die "certs/key.pem 读不出来（是否带密码？需要不带密码的私钥）"
[ "$CERT_PUB" = "$KEY_PUB" ] || die "证书和私钥不是一对"
openssl x509 -in certs/cert.pem -noout -checkend 0 >/dev/null || die "证书已过期"
openssl x509 -in certs/cert.pem -noout -checkend $((14 * 86400)) >/dev/null || warn "证书 14 天内过期，记得续"

DOMAIN="$(env_get DOMAIN)"
if [ -n "$DOMAIN" ] && ! openssl x509 -in certs/cert.pem -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q 'does match'; then
  die "证书不包含域名 $DOMAIN"
fi

chmod 644 certs/cert.pem
# caddy 容器以 root 读，私钥收紧到只有 root
chmod 600 certs/key.pem
echo 'tls /certs/cert.pem /certs/key.pem' > certs/tls.caddy

# reload 失败时 Caddy 还跑着旧配置；tls.caddy 留着的话下次重启就起不来，所以撤掉
caddy_reload || { rm -f certs/tls.caddy; die "Caddy 不接受这份证书（日志见上），已撤回，仍用自动申请的证书"; }
ok "已换用自己的证书（到期：$(openssl x509 -in certs/cert.pem -noout -enddate | cut -d= -f2)）"
