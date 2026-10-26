#!/usr/bin/env bash
# 【我方用】lib.sh 里几个判断函数的小测试，不需要 Docker：bash deploy/enterprise/tools/drill/test-lib.sh
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../../scripts" && pwd)/lib.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/scripts" && cp "$LIB" "$T/scripts/lib.sh"
# shellcheck source=/dev/null
source "$T/scripts/lib.sh"   # 会 cd 到 $T
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok  $1"; else echo "  FAIL $1：期望 $2，实际 $3"; fail=1; fi; }
for x in 10.0.0.8 127.0.0.1 192.168.1.255 0.0.0.0 8.8.8.8; do check "is_ipv4 $x" yes "$(is_ipv4 "$x" && echo yes || echo no)"; done
for x in 256.1.1.1 08.1.1.1 1.2.3 crm.example.com localhost ::1 1.2.3.4.5 ""; do check "is_ipv4 '$x'" no "$(is_ipv4 "$x" && echo yes || echo no)"; done
for pair in "crm.example.com=crm.example.com" "https://CRM.Example.com/login=crm.example.com" " 10.0.0.8 =10.0.0.8" \
            "http://10.0.0.8:443/=10.0.0.8" "localhost=localhost"; do
  check "normalize_host '${pair%%=*}'" "${pair#*=}" "$( (normalize_host "${pair%%=*}") 2>/dev/null || echo 报错)"
done
for x in "" "10.0.0.256" "1.2.3" "::1" "[fe80::1]" "https://"; do
  check "normalize_host '$x' 报错" 报错 "$( (normalize_host "$x") 2>/dev/null || echo 报错)"
done
mkdir -p certs
echo "DOMAIN=crm.example.com" > .env;  check "tls_mode 域名" auto "$(tls_mode)"
echo "DOMAIN=localhost" > .env;        check "tls_mode localhost" internal "$(tls_mode)"
echo "DOMAIN=10.0.0.8" > .env; echo 'tls internal' > certs/tls.caddy; check "tls_mode IP" internal "$(tls_mode)"
echo 'tls /certs/cert.pem /certs/key.pem' > certs/tls.caddy;          check "tls_mode 自有证书" own "$(tls_mode)"
exit "$fail"
