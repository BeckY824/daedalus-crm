#!/usr/bin/env bash
# 【我方用，不发给客户】在测试机上把一次升级完整走一遍，通过了才去客户服务器升级。
#
#   sudo deploy/enterprise/tools/verify-upgrade.sh --load crm-images-0.47.0.tar.gz   # 离线镜像包（和给客户的同一个包）
#   sudo deploy/enterprise/tools/verify-upgrade.sh 0.47.0                            # 在线拉取
#
# 测试机上先装好「客户现在跑的那个版本」（同一份部署包、样例数据），部署目录默认 /opt/crm-enterprise，
# 别的位置用 CRM_DIR=/path 指定。脚本调的是客户手里同一套 scripts/，不另写一套升级逻辑：
#   1. 记下当前版本、每张表的行数、核心业务表的内容哈希，经 HTTPS 打一次健康检查
#   2. upgrade.sh 升到新版本 → HTTPS 健康、版本对上、登录页能开、原有的表都在且行数没少、
#      核心业务表（客户、联系人、跟进、合同…）按起点时的列算的内容哈希和起点一模一样
#   3. rollback.sh 退回旧版本 → 同样检查（确认出事时真能退回去）
#   4. rollback.sh 再回到新版本 → 同样检查（测试机停在新版本，下一次升级从这里接着验）
# 任何一步不对就停下、非零退出。全部通过时在部署目录的 verify-upgrade.log 记一行。
# 证书是自签或内网 CA 时加 INSECURE=1（curl 不校验证书）；DOMAIN=localhost 自动不校验。
# 库是空的（CI、刚装的测试机）时加 FILL=1：先往每张表灌演练数据（drill/fill.js），不然「没少、没变」等于没验。
# 新版本有意改了某张核心表的旧数据（数据迁移）时，CORE_SKIP="表名 …" 跳过那几张，并在发版说明里写清楚。
set -euo pipefail

DRILL="$(cd "$(dirname "$0")/drill" && pwd)"

CRM_DIR="${CRM_DIR:-/opt/crm-enterprise}"
[ -f "$CRM_DIR/scripts/lib.sh" ] || { echo "❌ $CRM_DIR 不是部署目录（没有 scripts/lib.sh），用 CRM_DIR=/path 指定" >&2; exit 1; }
# lib.sh 会 cd 到部署目录
source "$CRM_DIR/scripts/lib.sh"
need_docker

case "${1:-}" in
  "" | -h | --help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
# --load 的包路径是相对调用处写的，lib.sh 已经 cd 走了，这里换成绝对路径
ARGS=("$@")
if [ "${ARGS[0]}" = "--load" ] && [ -n "${ARGS[1]:-}" ]; then
  ARGS[1]="$(cd "$OLDPWD" && cd "$(dirname "${ARGS[1]}")" && pwd)/$(basename "${ARGS[1]}")"
fi

DOMAIN="$(env_get DOMAIN)"
[ -n "$DOMAIN" ] || die ".env 里没有 DOMAIN"
CURL=(curl -fsS --max-time 20 --resolve "$DOMAIN:443:127.0.0.1")
if [ "${INSECURE:-}" = "1" ] || [ "$(tls_mode)" = internal ]; then CURL+=(-k); fi

# 每张表的行数，一行一张「表名 行数」，按表名排好
table_counts() {
  crm_sh 'node --experimental-sqlite -e "
    const { DatabaseSync } = require(\"node:sqlite\");
    const db = new DatabaseSync(\"/data/crm.db\");
    const ts = db.prepare(\"SELECT name FROM sqlite_master WHERE type=\x27table\x27 AND name NOT LIKE \x27sqlite_%\x27 ORDER BY name\").all();
    for (const t of ts) console.log(t.name + \" \" + db.prepare(\"SELECT COUNT(*) AS n FROM \\\"\" + t.name + \"\\\"\").get().n);
  " 2>/dev/null'
}

# 核心业务表的内容哈希。第一次（不带参数）第一行是起点各表的列，之后传这行进来，只按这些列算
core_hash() {
  { if [ -n "${1:-}" ]; then printf 'const BASE = %s;\n' "$1"; fi; cat "$DRILL/core-hash.js"; } |
    crm_sh "CORE_SKIP='${CORE_SKIP:-}' node --experimental-sqlite - 2>/dev/null"
}

# 以前有的表现在都还在、行数没少（新版本可以加表，启动时也可能写几行日志，所以只查「没少」）
compare_counts() {
  local before="$1" after="$2" bad=0 name n now
  while read -r name n; do
    [ -n "$name" ] || continue
    now="$(printf '%s\n' "$after" | awk -v t="$name" '$1==t{print $2}')"
    if [ -z "$now" ]; then warn "表 $name 不见了"; bad=1
    elif [ "$now" -lt "$n" ]; then warn "表 $name 行数 $n → ${now}，变少了"; bad=1
    fi
  done <<< "$before"
  return "$bad"
}

# 经 Caddy 走 HTTPS：健康、版本对上、登录页能开
check_https() {
  local want="$1" body
  body="$("${CURL[@]}" "https://$DOMAIN/api/health")" || die "https://$DOMAIN/api/health 打不通"
  printf '%s' "$body" | grep -q "\"version\":\"$want\"" || die "HTTPS 上的版本不对：要 ${want}，实际 $body"
  "${CURL[@]}" -o /dev/null "https://$DOMAIN/login" || die "https://$DOMAIN/login 打不开"
}

STEP=0
check_all() {
  local want="$1" now
  check_https "$want"
  now="$(table_counts)"
  [ -n "$now" ] || die "读不到数据库的表"
  compare_counts "$BASE" "$now" || die "数据核对不通过（见上面）"
  now="$(core_hash "$CORE_COLS")"
  if [ "$now" != "$CORE" ]; then
    warn "核心业务表的内容和起点不一样："
    diff <(printf '%s\n' "$CORE") <(printf '%s\n' "$now") | grep '^[<>]' >&2 || true
    die "数据核对不通过（新版本有意改旧数据的话用 CORE_SKIP 跳过那张表）"
  fi
  STEP=$((STEP + 1))
  ok "第 $STEP 步通过：${want}，HTTPS 正常，$(printf '%s\n' "$BASE" | wc -l | tr -d ' ') 张原有表都在、行数没少，$(printf '%s\n' "$CORE" | wc -l | tr -d ' ') 张核心表内容一致"
}

crm_running || die "应用没在跑。测试机先按部署手册装好客户现在的版本"
OLD="$(current_version)"
[ -n "$OLD" ] || die "健康检查没响应，先让旧版本正常跑起来"
[ "$OLD" = "$(env_get CRM_VERSION)" ] || die "正在跑的是 ${OLD}，.env 写的是 $(env_get CRM_VERSION)，先对齐"
say "起点：${OLD}（客户现在跑的应该也是这个版本）"
check_https "$OLD"
if [ "${FILL:-}" = "1" ]; then
  say "灌演练数据…"
  docker compose exec -T crm node --experimental-sqlite - < "$DRILL/fill.js"
fi
BASE="$(table_counts)"
[ -n "$BASE" ] || die "读不到数据库的表"
echo "   $(printf '%s\n' "$BASE" | wc -l | tr -d ' ') 张表，共 $(printf '%s\n' "$BASE" | awk '{s+=$2} END{print s+0}') 行"
CORE="$(core_hash)"
CORE_COLS="$(printf '%s\n' "$CORE" | head -1)"
CORE="$(printf '%s\n' "$CORE" | tail -n +2)"
[ -n "$CORE" ] || die "读不到核心业务表"
# 迁移记录、初始管理员这些装好就有，不算；客户、跟进这些业务表一行都没有就是空库
[ "$(printf '%s\n' "$CORE" | awk '$2!="User"{s+=$3} END{print s+0}')" -gt 0 ] ||
  die "库是空的，验了也说明不了数据没丢。加 FILL=1 先灌演练数据，或先导入样例数据"

say "1/3 升级（和客户执行的是同一个 upgrade.sh）"
"$DEPLOY_DIR/scripts/upgrade.sh" "${ARGS[@]}"
NEW="$(env_get CRM_VERSION)"
[ "$NEW" != "$OLD" ] || die "升级后版本还是 ${OLD}：新版本号和当前一样？"
check_all "$NEW"

say "2/3 回滚到 $OLD"
"$DEPLOY_DIR/scripts/rollback.sh"
check_all "$OLD"

say "3/3 再升回 $NEW"
"$DEPLOY_DIR/scripts/rollback.sh"
check_all "$NEW"

echo "$(date '+%Y-%m-%d %H:%M:%S') 测试机验证通过 $OLD → ${NEW}（升级、回滚、再升级）" >> verify-upgrade.log
ok "测试机验证通过：$OLD → $NEW 升级、回滚、再升级都正常，数据没少。可以去客户服务器升级（见 tools/UPGRADE-RUNBOOK.md）"
