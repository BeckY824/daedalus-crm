#!/usr/bin/env bash
# 装好之后的冒烟检查：管理员登录 → 加一个成员 → 成员登录 → 健康检查。
# 只用 curl 和系统自带的小工具，走的是浏览器同一条路（页面上的登录、加成员按钮背后的 server action）。
#
#   在服务器的部署目录里（自动读 .env 的 DOMAIN）：
#     sudo ./tools/smoke.sh                       # 会提示输入 admin 密码，不回显
#     CRM_ADMIN_PASSWORD=… sudo -E ./tools/smoke.sh
#   在别的机器上：
#     ./tools/smoke.sh --url https://crm.example.com --password-file ./admin.pass
#
# 参数：
#   --url URL            要测的地址（默认 https://<.env 里的 DOMAIN>，直连本机 127.0.0.1）
#   --admin NAME         管理员登录名，默认 admin
#   --password-file F    从文件第一行读管理员密码（也可用环境变量 CRM_ADMIN_PASSWORD）
#   --insecure           不校验 HTTPS 证书（IP 访问 / 内部 CA 时自动打开）
#   --manifest F         从页面找不到按钮对应的 action 时，改读这个 server-reference-manifest.json
#   --keep-member        测完不停用测试成员（默认停用，名下没有数据，不影响别人）
#
# 不会把任何密码打印出来：密码只经管道喂给 curl，不进命令行参数，也不进日志。
# 测试成员叫「冒烟测试」，登录名 smoke-<时间>，密码随机、测完即弃。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
URL="" ADMIN="admin" PASS_FILE="" INSECURE=0 MANIFEST="" KEEP=0 RESOLVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url)           URL="${2:-}"; shift 2 ;;
    --admin)         ADMIN="${2:-}"; shift 2 ;;
    --password-file) PASS_FILE="${2:-}"; shift 2 ;;
    --insecure)      INSECURE=1; shift ;;
    --manifest)      MANIFEST="${2:-}"; shift 2 ;;
    --keep-member)   KEEP=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数 $1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '▶ %s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

is_ipv4() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# 部署目录 = 本脚本上一级（部署包里 tools/ 和 scripts/ 平级）
DEPLOY_DIR="$(cd "$HERE/.." && pwd)"
env_get() { [ -f "$DEPLOY_DIR/.env" ] || return 0; { grep -E "^$1=" "$DEPLOY_DIR/.env" || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ -z "$URL" ]; then
  DOMAIN="$(env_get DOMAIN)"
  [ -n "$DOMAIN" ] || fail "没给 --url，部署目录 $DEPLOY_DIR 里也没有 .env 的 DOMAIN"
  URL="https://$DOMAIN"
  # 在服务器上跑：不绕外网，直接打本机的 443（域名还没解析好也能测）
  is_ipv4 "$DOMAIN" || RESOLVE="$DOMAIN:443:127.0.0.1"
  if is_ipv4 "$DOMAIN" || [ "$DOMAIN" = localhost ] || grep -qs 'tls internal' "$DEPLOY_DIR"/certs/tls*.caddy; then INSECURE=1; fi
fi
URL="${URL%/}"
HOSTPART="$(printf '%s' "$URL" | sed -e 's|^[a-z]*://||' -e 's|/.*$||')"
case "$URL" in https://*) is_ipv4 "${HOSTPART%%:*}" && INSECURE=1 ;; esac

# ── 管理员密码 ─────────────────────────────────────────
ADMIN_PASS="${CRM_ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASS" ] && [ -n "$PASS_FILE" ]; then
  [ -r "$PASS_FILE" ] || fail "读不了密码文件 $PASS_FILE"
  ADMIN_PASS="$(head -1 "$PASS_FILE" | tr -d '\r\n')"
fi
if [ -z "$ADMIN_PASS" ] && [ -t 0 ]; then
  printf '管理员 %s 的密码（不回显）：' "$ADMIN"; read -rs ADMIN_PASS; echo
fi
[ -n "$ADMIN_PASS" ] || fail "没有管理员密码：用 --password-file、环境变量 CRM_ADMIN_PASSWORD，或在终端里交互输入"

TMP="$(mktemp -d)"; chmod 700 "$TMP"
trap 'rc=$?; rm -rf "$TMP"; exit $rc' EXIT

CURL=(curl -sS --max-time 30)
[ "$INSECURE" = 1 ] && CURL+=(-k)
[ -n "$RESOLVE" ] && CURL+=(--resolve "$RESOLVE")
ORIGIN="$(printf '%s' "$URL" | sed -E 's|^([a-z]+://[^/]+).*|\1|')"

# JSON 字符串转义（密码里可能有 " 和 \）
js() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# 调一个 server action：$1 页面路径 $2 action id $3 cookie 文件（读写）；请求体从标准输入来
# 输出：响应体写到 $TMP/resp，HTTP 状态码打印到标准输出
call_action() {
  "${CURL[@]}" -o "$TMP/resp" -w '%{http_code}' -b "$3" -c "$3" -X POST "$URL$1" \
    -H "Next-Action: $2" -H 'Accept: text/x-component' \
    -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $ORIGIN" \
    --data-binary @-
}
resp_ok()    { grep -q '"ok":true' "$TMP/resp"; }
resp_error() { grep -o '"error":"[^"]*"' "$TMP/resp" | head -1 | cut -d'"' -f4; }

# 从页面引用的前端脚本里找按钮对应的 action id：
#   createServerReference)("<id>",…,"login")
# 每次发版 id 都会变，所以不写死。$1 页面路径 $2 函数名 $3 cookie 文件
find_action() {
  local page="$1" name="$2" jar="$3" c id
  "${CURL[@]}" -b "$jar" -o "$TMP/page.html" "$URL$page" || true
  for c in $(grep -o '/_next/static/chunks/[A-Za-z0-9_.~-]*\.js' "$TMP/page.html" | sort -u); do
    id="$("${CURL[@]}" "$URL$c" 2>/dev/null | grep -o "createServerReference)(\"[0-9a-f]\{40,\}\",[^)]*,\"$name\")" | head -1 | cut -d'"' -f2 || true)"
    [ -n "$id" ] && { printf '%s' "$id"; return 0; }
  done
  # 页面上没找到（比如那段界面是用到时才加载的）：读构建产物里的清单
  local m="$TMP/manifest.json"
  if [ -n "$MANIFEST" ]; then
    cp "$MANIFEST" "$m"
  elif [ -f "$DEPLOY_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    (cd "$DEPLOY_DIR" && docker compose exec -T crm cat /app/.next/server/server-reference-manifest.json) > "$m" 2>/dev/null || true
  fi
  [ -s "$m" ] || return 1
  # 清单是格式化过的 JSON：每个 action 是 "<id>": { … "exportedName": "<名字>" … }
  awk -v want="$name" '
    /^    "[0-9a-f]+": \{/ { gsub(/[" :{]/, ""); cur = $0 }
    /"exportedName":/ { v = $0; sub(/.*"exportedName": "/, "", v); sub(/".*/, "", v); if (v == want && cur != "") { print cur; exit } }
  ' "$m"
}

STAMP="$(date +%Y%m%d-%H%M%S)"
MEMBER="smoke-$STAMP"
MEMBER_PASS="$(openssl rand -base64 18 | tr -d '/+=\n' | cut -c1-16)"
ADMIN_JAR="$TMP/admin.jar" MEMBER_JAR="$TMP/member.jar"
: > "$ADMIN_JAR"; : > "$MEMBER_JAR"

say "目标 $URL$([ "$INSECURE" = 1 ] && echo '（不校验证书）')"

# ── 1. 健康检查 ───────────────────────────────────────
H="$("${CURL[@]}" "$URL/api/health" || true)"
printf '%s' "$H" | grep -q '"ok":true' || fail "/api/health 不正常：${H:-没有响应}"
ok "健康检查：$H"

# ── 2. 管理员登录 ─────────────────────────────────────
LOGIN_ID="$(find_action /login login "$ADMIN_JAR" || true)"
[ -n "$LOGIN_ID" ] || fail "在登录页上找不到登录按钮对应的 action（版本不对？试试 --manifest）"
code="$(printf '["%s","%s"]' "$(js "$ADMIN")" "$(js "$ADMIN_PASS")" | call_action /login "$LOGIN_ID" "$ADMIN_JAR")"
[ "$code" = 200 ] && resp_ok || fail "管理员 $ADMIN 登录失败（HTTP ${code}）：$(resp_error)"
grep -q crm_session "$ADMIN_JAR" || fail "管理员登录返回成功，但没拿到会话 cookie（http 访问时 COOKIE_SECURE 要设 false）"
ok "管理员 $ADMIN 登录成功"

# ── 3. 加成员 ─────────────────────────────────────────
SAVE_ID="$(find_action /settings saveUser "$ADMIN_JAR" || true)"
[ -n "$SAVE_ID" ] || fail "在设置页上找不到「加成员」对应的 action（试试 --manifest）"
code="$(printf '[{"name":"冒烟测试","email":"%s","title":"","role":"SALES","password":"%s","active":true,"force":true}]' "$MEMBER" "$(js "$MEMBER_PASS")" | call_action /settings "$SAVE_ID" "$ADMIN_JAR")"
[ "$code" = 200 ] && resp_ok || fail "加成员失败（HTTP ${code}）：$(resp_error)"
ok "已加成员 ${MEMBER}（销售）"

# ── 4. 成员登录 ───────────────────────────────────────
code="$(printf '["%s","%s"]' "$MEMBER" "$(js "$MEMBER_PASS")" | call_action /login "$LOGIN_ID" "$MEMBER_JAR")"
[ "$code" = 200 ] && resp_ok || fail "新成员登录失败（HTTP ${code}）：$(resp_error)"
grep -q crm_session "$MEMBER_JAR" || fail "新成员登录返回成功，但没拿到会话 cookie"
# 拿这个会话真的打开一页：会话无效时页面会跳去 /api/auth/logout
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -b "$MEMBER_JAR" "$URL/dashboard")"
[ "$code" = 200 ] || fail "新成员登录后打开首页不是 200（HTTP ${code}）"
ok "新成员 $MEMBER 登录成功，能打开首页"

# ── 5. 收尾：停用测试成员 ─────────────────────────────
if [ "$KEEP" = 0 ]; then
  # 成员 id 从设置页里找（页面数据里 "id":"…" 紧挨着 "email":"smoke-…"）
  "${CURL[@]}" -b "$ADMIN_JAR" -o "$TMP/settings.html" "$URL/settings" || true
  sed 's/\\"/"/g' "$TMP/settings.html" | tr '{' '\n' | grep "\"email\":\"$MEMBER\"" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 > "$TMP/mid" || true
  sed 's/\\"/"/g' "$TMP/settings.html" | tr '{' '\n' | grep '"email":"'"$(js "$ADMIN")"'"' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 > "$TMP/aid" || true
  MID="$(cat "$TMP/mid")" AID="$(cat "$TMP/aid")"
  DEACT_ID="$(find_action /settings deactivateUser "$ADMIN_JAR" || true)"
  if [ -n "$MID" ] && [ -n "$AID" ] && [ -n "$DEACT_ID" ]; then
    code="$(printf '["%s","%s"]' "$MID" "$AID" | call_action /settings "$DEACT_ID" "$ADMIN_JAR")"
    if [ "$code" = 200 ] && resp_ok; then ok "已停用测试成员 $MEMBER"; else printf '⚠️  停用测试成员没成功（HTTP %s）：%s——可在「设置管理 → 成员」里手动停用\n' "$code" "$(resp_error)" >&2; fi
  else
    printf '⚠️  没找到测试成员 %s 的 id，没停用——可在「设置管理 → 成员」里手动停用\n' "$MEMBER" >&2
  fi
fi

# ── 6. 再查一次健康 ───────────────────────────────────
H="$("${CURL[@]}" "$URL/api/health" || true)"
printf '%s' "$H" | grep -q '"ok":true' || fail "最后一次 /api/health 不正常：${H:-没有响应}"
ok "冒烟通过：管理员登录、加成员、成员登录、健康检查都正常"
