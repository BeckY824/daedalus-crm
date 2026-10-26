#!/usr/bin/env bash
# 【我方用，不发给客户】恢复演练：证明备份真能恢复，坏备份不会把好数据弄坏。CI 每次跑三遍，测试机上也能跑。
#
#   sudo deploy/enterprise/tools/restore-drill.sh --fill   # 先往每张表灌演练数据（CI、刚装好的测试机）
#   sudo deploy/enterprise/tools/restore-drill.sh          # 用库里现有的数据（测试机上导入了样例数据时）
#
# 部署目录默认 /opt/crm-enterprise，别的位置用 CRM_DIR=/path。调的是客户手里同一套 scripts/：
#   1. 停应用，给整个数据卷拍指纹 A（每张表的行数 + 内容哈希、表结构、附件等文件的哈希）
#   2. backup.sh 备份，备份文件和备份密码拷到部署目录外面（模拟异地保管）；备份解开的指纹必须等于 A
#   3. 五种坏备份（截断、中间改一个字节、密码不对、随机字节、没有数据库的包）都必须被 restore.sh 拒绝，指纹不变
#   4. 清空：docker compose down -v，删掉 backups/ 和本机的备份密码——当作服务器整个没了
#   5. 只拿异地那份备份和密码恢复（先不启动），指纹必须和 A 一模一样
#   6. 启动，经 HTTPS 打健康检查、开登录页；启动时的迁移跑完后表都还在、行数没少
# 任何一步不对就停下、非零退出。通过时在部署目录的 restore-drill.log 记一行（含恢复用时）。
# 会清空数据卷：只在 CI 和测试机上跑，别在客户服务器上跑。
set -euo pipefail

DRILL="$(cd "$(dirname "$0")/drill" && pwd)"
CRM_DIR="${CRM_DIR:-/opt/crm-enterprise}"
[ -f "$CRM_DIR/scripts/lib.sh" ] || { echo "❌ $CRM_DIR 不是部署目录（没有 scripts/lib.sh），用 CRM_DIR=/path 指定" >&2; exit 1; }
# lib.sh 会 cd 到部署目录
source "$CRM_DIR/scripts/lib.sh"
need_docker

FILL=0
case "${1:-}" in
  --fill) FILL=1 ;;
  "") ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

DOMAIN="$(env_get DOMAIN)"
[ -n "$DOMAIN" ] || die ".env 里没有 DOMAIN"
CURL=(curl -fsS --max-time 20 --resolve "$DOMAIN:443:127.0.0.1")
if [ "${INSECURE:-}" = "1" ] || [ "$(tls_mode)" = internal ]; then CURL+=(-k); fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
OFFSITE="$WORK/offsite"
mkdir -p "$OFFSITE"

# 数据卷指纹。容器在跑就 exec 进去，没跑就临时起一个（lib.sh 的 crm_sh）
snap() { crm_sh 'node --experimental-sqlite -' < "$DRILL/snapshot.js"; }

# 两份指纹必须一模一样，不一样就把差别打出来
same() {
  local what="$1" a="$2" b="$3"
  if [ "$a" != "$b" ]; then
    warn "${what}：数据和备份前不一样"
    diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | head -40 >&2 || true
    die "恢复演练不通过"
  fi
}

summary() { printf '%s\n' "$1" | awk '$1=="table"{t++; r+=$3} $1=="file"{f++} END{printf "%d 张表、%d 行、%d 个文件", t, r, f}'; }

# ── 0. 起点 ───────────────────────────────────────────
crm_running || die "应用没在跑。先按部署手册装好"
VER="$(current_version)"
[ -n "$VER" ] || die "健康检查没响应，先让应用正常跑起来"
say "起点：${VER}"
if [ "$FILL" = 1 ]; then
  say "灌演练数据…"
  docker compose exec -T crm node --experimental-sqlite - < "$DRILL/fill.js"
fi

# ── 1. 指纹 A ─────────────────────────────────────────
say "1/6 停应用，拍指纹 A"
docker compose stop crm >/dev/null
A="$(snap)"
printf '%s\n' "$A" | head -1 | grep -qx 'integrity ok' || die "库本身就不完整：$(printf '%s\n' "$A" | head -1)"
ok "A：$(summary "$A")"

# ── 2. 备份、异地保管 ──────────────────────────────────
say "2/6 备份（和客户每天凌晨跑的是同一个 backup.sh）"
"$DEPLOY_DIR/scripts/backup.sh"
BK="$(ls -1t backups/crm-*.tar.gz.enc | head -1)"
cp "$BK" "$OFFSITE/"
cp "$(backup_pass_file)" "$OFFSITE/backup.pass"
GOOD="$OFFSITE/$(basename "$BK")"
dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$OFFSITE/backup.pass" < "$1"; }
mkdir "$WORK/b0"
dec "$GOOD" | tar -xzf - -C "$WORK/b0"
B0="$(docker compose run --rm --no-deps -T -u 0 -v "$WORK/b0:/b0" -e DATA_DIR=/b0 --entrypoint node crm --experimental-sqlite - < "$DRILL/snapshot.js")"
same "备份文件里的数据" "$A" "$B0"
ok "备份 $(basename "$BK")（$(du -h "$GOOD" | cut -f1)）解开和 A 一样"

# ── 3. 坏备份必须被拒绝 ────────────────────────────────
say "3/6 坏备份必须被拒绝、数据不动"
SIZE="$(wc -c < "$GOOD" | tr -d ' ')"
head -c "$((SIZE / 2))" "$GOOD" > "$WORK/bad-截断.enc"
cp "$GOOD" "$WORK/bad-改一个字节.enc"
python3 - "$WORK/bad-改一个字节.enc" <<'PY'
import sys
p = sys.argv[1]
with open(p, "r+b") as f:
    f.seek(0, 2); n = f.tell(); f.seek(n // 2)
    b = f.read(1); f.seek(n // 2); f.write(bytes([b[0] ^ 0xFF]))
PY
head -c 1048576 /dev/urandom > "$WORK/bad-随机字节.enc"
mkdir "$WORK/nodb" && echo 不是数据库 > "$WORK/nodb/readme.txt"
tar -czf - -C "$WORK/nodb" . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$OFFSITE/backup.pass" > "$WORK/bad-没有数据库.enc"
openssl rand -hex 32 > "$WORK/wrong.pass"

refuse() {
  local name="$1" file="$2" pass="$3"
  if BACKUP_PASS_FILE="$pass" CONFIRM=RESTORE SKIP_PREBACKUP=1 NO_START=1 "$DEPLOY_DIR/scripts/restore.sh" "$file" >"$WORK/out" 2>&1; then
    cat "$WORK/out" >&2
    die "${name}：restore.sh 居然恢复成功了"
  fi
  same "$name 之后" "$A" "$(snap)"
  ok "${name}：拒绝了（$(grep -o '❌.*' "$WORK/out" | head -1)），数据没动"
}
refuse "截断一半" "$WORK/bad-截断.enc" "$OFFSITE/backup.pass"
refuse "中间改一个字节" "$WORK/bad-改一个字节.enc" "$OFFSITE/backup.pass"
refuse "密码不对" "$GOOD" "$WORK/wrong.pass"
refuse "随机字节" "$WORK/bad-随机字节.enc" "$OFFSITE/backup.pass"
refuse "没有数据库的包" "$WORK/bad-没有数据库.enc" "$OFFSITE/backup.pass"

# ── 4. 清空 ───────────────────────────────────────────
say "4/6 清空：数据卷、本机备份、本机备份密码全删"
docker compose down -v >/dev/null 2>&1
rm -rf "${DEPLOY_DIR:?}/backups"
rm -f "$(backup_pass_file)"
if docker volume ls -q | grep -q 'crm-data$'; then die "数据卷还在，没清干净"; fi

# ── 5. 只拿异地那份恢复 ────────────────────────────────
say "5/6 只拿异地的备份和密码恢复（先不启动）"
T0="$(date +%s)"
BACKUP_PASS_FILE="$OFFSITE/backup.pass" CONFIRM=RESTORE SKIP_PREBACKUP=1 NO_START=1 \
  "$DEPLOY_DIR/scripts/restore.sh" "$GOOD"
B="$(snap)"
same "恢复后" "$A" "$B"
ok "恢复后和 A 一模一样：$(summary "$B")"

# ── 6. 启动 ───────────────────────────────────────────
say "6/6 启动，经 HTTPS 检查"
docker compose up -d >/dev/null
wait_healthy "$VER" 300 || die "恢复后应用没能在 5 分钟内启动，看日志：docker compose logs --tail 200 crm"
SECS="$(( $(date +%s) - T0 ))"
for i in $(seq 1 24); do
  "${CURL[@]}" "https://$DOMAIN/api/health" >/dev/null 2>&1 && break
  [ "$i" = 24 ] && die "https://$DOMAIN/api/health 打不通"
  sleep 5
done
"${CURL[@]}" -o /dev/null "https://$DOMAIN/login" || die "https://$DOMAIN/login 打不开"
# 启动时会把迁移再跑一遍、可能写几行日志，这里只查「表都在、行数没少」
C="$(snap)"
bad=0
while read -r kind name n _; do
  [ "$kind" = table ] || continue
  now="$(printf '%s\n' "$C" | awk -v t="$name" '$1=="table" && $2==t {print $3}')"
  if [ -z "$now" ]; then warn "启动后表 $name 不见了"; bad=1
  elif [ "$now" -lt "$n" ]; then warn "启动后表 $name 行数 $n → ${now}，变少了"; bad=1
  fi
done <<< "$A"
[ "$bad" = 0 ] || die "启动后数据核对不通过"

# 机器留在能接着用的状态：本机备份密码放回去
mkdir -p backups secrets && chmod 700 backups secrets
cp "$OFFSITE/backup.pass" "$(backup_pass_file)" && chmod 600 "$(backup_pass_file)"

echo "$(date '+%Y-%m-%d %H:%M:%S') 恢复演练通过 ${VER}，$(summary "$A")，恢复到能用 ${SECS} 秒" >> restore-drill.log
ok "恢复演练通过：$(summary "$A")，逐表逐文件一致；5 种坏备份都被拒绝；从清空到能用 ${SECS} 秒"
