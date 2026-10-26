#!/usr/bin/env bash
# 备份整个数据卷（数据库 + 附件 + 会话密钥），加密后放进 backups/。
#
#   sudo ./scripts/backup.sh
#
# install.sh 已经把它装进了每天定时任务（/etc/cron.d/crm-backup），平时不用手动跑。
# 升级、恢复之前脚本也会自动先备一份。
#
# 产物：backups/crm-<时间>.tar.gz.enc，用贵司自己保管的备份密码加密（AES-256）。
# 没有密码解不开——密码丢了备份就废了，所以密码务必另存一份在服务器以外。
#
# 可调（写在 .env）：
#   BACKUP_KEEP=30        保留最近几份，多出的从最旧的删
#   BACKUP_COPY_DIR=      再复制一份到这个目录（比如挂载的另一块盘 / NAS），同样按 BACKUP_KEEP 保留
#   BACKUP_PASS_FILE=     备份密码文件位置，默认 secrets/backup.pass
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need_docker

PASS_FILE="$(backup_pass_file)"
[ -s "$PASS_FILE" ] || die "没有备份密码（${PASS_FILE}）。先执行 sudo ./scripts/backup-password.sh 生成"

KEEP="$(env_get BACKUP_KEEP)"; KEEP="${KEEP:-30}"
COPY_DIR="$(env_get BACKUP_COPY_DIR)"
mkdir -p backups
chmod 700 backups

# 同一时间只跑一份：定时任务和手动备份撞上时，后来的直接退出
LOCK="$DEPLOY_DIR/backups/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # 锁超过 6 小时视为上次异常退出留下的
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    rmdir "$LOCK" && mkdir "$LOCK"
  else
    die "另一份备份正在进行（${LOCK}）"
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true; rm -f "${PART:-}"' EXIT

# 文件名按秒取；同一秒里跑第二次（手动连点、升级前自动备份紧跟着手动备份）就加序号 -2、-3…，
# 另存目录里有同名的也跳过。下面那条「拒绝覆盖」照留着，兜底
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="crm-$STAMP"
N=1
while [ -e "backups/$NAME.tar.gz.enc" ] || { [ -n "$COPY_DIR" ] && [ -e "$COPY_DIR/$NAME.tar.gz.enc" ]; }; do
  N=$((N + 1))
  [ "$N" -gt 99 ] && break
  NAME="crm-$STAMP-$N"
done
OUT="backups/$NAME.tar.gz.enc"
PART="$OUT.part"
[ -e "$OUT" ] && die "$OUT 已存在，拒绝覆盖"

say "拍快照、打包、加密…"
# 不能直接打包 crm.db：数据库跑在 WAL 模式，最近的写入还在 crm.db-wal 里。
# VACUUM INTO 拿一份一致的快照，再和其余文件（附件、会话密钥）一起打包。
# 快照和打包必须在同一次 crm_sh 里：容器没在跑时每次 crm_sh 都是一个新的临时容器，
# 上一次留在 /tmp 里的快照下一次就看不到了
crm_sh '
  set -e
  [ -f /data/crm.db ] || { echo "数据卷里没有 crm.db" >&2; exit 3; }
  rm -rf /tmp/crm-bk && mkdir -p /tmp/crm-bk
  node --experimental-sqlite -e "
    const { DatabaseSync } = require(\"node:sqlite\");
    const q = String.fromCharCode(39);
    new DatabaseSync(\"/data/crm.db\").exec(\"VACUUM INTO \" + q + \"/tmp/crm-bk/crm.db\" + q);
  " 2>/dev/null
  tar -czf - -C /data \
    --exclude=./crm.db --exclude=./crm.db-wal --exclude=./crm.db-shm \
    --exclude="./pre-rebuild-*" --exclude=./restore-tmp . \
    -C /tmp/crm-bk crm.db
  rm -rf /tmp/crm-bk
' | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASS_FILE" > "$PART"

say "校验（解密一遍、读一遍目录）…"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE" < "$PART" | tar -tzf - | grep -x 'crm.db' >/dev/null \
  || die "校验失败：备份文件不完整，已丢弃"

chmod 600 "$PART"
mv "$PART" "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"

prune() {
  # 只动本脚本产出的文件名，别的东西一律不碰
  local dir="$1"
  ls -1t "$dir"/crm-*.tar.gz.enc 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r f; do rm -f -- "$f"; done
}
prune backups

if [ -n "$COPY_DIR" ]; then
  if [ -d "$COPY_DIR" ] && [ -w "$COPY_DIR" ]; then
    cp "$OUT" "$COPY_DIR/" && prune "$COPY_DIR" && say "已另存一份到 $COPY_DIR"
  else
    warn "BACKUP_COPY_DIR=$COPY_DIR 不存在或不可写，这次没有另存"
  fi
fi

date '+%Y-%m-%d %H:%M:%S' > backups/LAST_OK
ok "已备份 → ${OUT}（${SIZE}，保留最近 $KEEP 份）"
