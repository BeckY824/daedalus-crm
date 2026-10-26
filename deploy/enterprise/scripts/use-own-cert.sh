#!/usr/bin/env bash
# 改用贵司自己的 HTTPS 证书（不用自动申请的 Let's Encrypt 证书时）。
#
#   1. 把证书放进部署目录的 certs/：
#        certs/cert.pem   证书（含中间证书链，一般叫 fullchain）
#        certs/key.pem    私钥
#   2. sudo ./scripts/use-own-cert.sh
#
# 证书续期后：覆盖这两个文件，再执行一次本脚本。
# 改回默认：sudo ./scripts/use-own-cert.sh --auto
#   访问地址是域名 → 自动向 Let's Encrypt 申请；是 IP → Caddy 内部 CA 签发（公网证书机构不给 IP 发证书）
#
# 用 IP 访问时，贵司证书里要有这个 IP（SAN 里的 IP Address）。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# 不用自有证书时 tls.caddy 该是什么样：IP 用内部 CA，域名删掉（走自动申请）
default_tls() {
  if is_ipv4 "$(env_get DOMAIN)"; then echo 'tls internal' > certs/tls.caddy; chmod 644 certs/tls.caddy
  else rm -f certs/tls.caddy
  fi
}
default_tls_name() { is_ipv4 "$(env_get DOMAIN)" && echo "内部 CA 签发的证书" || echo "自动申请的证书"; }

# reload 成功时 Caddy 会刷一屏 JSON 日志，只在失败时给人看
caddy_reload() {
  local out
  out="$(docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
}

need_docker

mkdir -p certs
if [ "${1:-}" = "--auto" ]; then
  default_tls
  caddy_reload
  ok "已改回$(default_tls_name)"
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
if is_ipv4 "$DOMAIN"; then
  openssl x509 -in certs/cert.pem -noout -checkip "$DOMAIN" 2>/dev/null | grep -q 'does match' || die "证书不包含 IP $DOMAIN"
elif [ -n "$DOMAIN" ] && ! openssl x509 -in certs/cert.pem -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q 'does match'; then
  die "证书不包含域名 $DOMAIN"
fi

chmod 644 certs/cert.pem
# caddy 容器以 root 读，私钥收紧到只有 root
chmod 600 certs/key.pem
echo 'tls /certs/cert.pem /certs/key.pem' > certs/tls.caddy

# reload 失败时 Caddy 还跑着旧配置；tls.caddy 留着的话下次重启就起不来，所以撤掉
caddy_reload || { default_tls; die "Caddy 不接受这份证书（日志见上），已撤回，仍用$(default_tls_name)"; }
ok "已换用自己的证书（到期：$(openssl x509 -in certs/cert.pem -noout -enddate | cut -d= -f2)）"
