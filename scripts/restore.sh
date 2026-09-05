#!/usr/bin/env bash
# 从本地备份恢复线上数据库。
#
#   CONFIRM=RESTORE ./scripts/restore.sh backups/crm-20260829-1658.db
#
# 这是**破坏性操作**：线上当前的数据会被整个替换掉。
# 因此必须显式带 CONFIRM=RESTORE，且脚本会先自动备份一份当前状态再动手。
#
# 两个容易踩的坑：
#   1. 数据库跑在 WAL 模式下，crm.db 旁边还有 crm.db-wal / crm.db-shm。
#      只换 crm.db 不删这两个，SQLite 起来会把旧的 WAL 重放到新文件上——
#      表现是「恢复完了数据还是错的」，而且看不出哪里错。
#   2. 必须先停容器再换文件。运行中的进程持有着文件句柄，
#      换掉的是目录项，进程仍在写旧的 inode。
set -euo pipefail

HOST="${CRM_HOST:?请设置 CRM_HOST，例如 CRM_HOST=root@your-server ./scripts/restore.sh}"
REMOTE_DIR=/opt/crm
SRC="${1:-}"

cd "$(dirname "$0")/.."

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "用法：CONFIRM=RESTORE $0 <备份文件>"
  echo "可用的备份："
  ls -1t backups/*.db 2>/dev/null | head -10 || echo "  （backups/ 下没有备份）"
  exit 1
fi

if [ "${CONFIRM:-}" != "RESTORE" ]; then
  echo "!! 这会用 $SRC 覆盖线上数据库，线上当前数据将全部丢失。"
  echo "!! 确认要做，请带上 CONFIRM=RESTORE 重新执行。"
  exit 1
fi

echo "▶ 0/5 校验备份文件本身…"
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('$SRC');
const t = d.prepare(\"select count(*) c from sqlite_master where type='table' and name='User'\").get();
if (!t.c) { console.error('  这个文件里没有 User 表，不像是本系统的备份'); process.exit(1); }
for (const x of ['User','Customer','Contract','FollowUp'])
  console.log('  ' + x + ': ' + d.prepare('select count(*) c from ' + x).get().c);
" 2>/dev/null

echo "▶ 1/5 先备份线上当前状态（恢复错了还能回来）…"
./scripts/backup.sh >/dev/null
echo "  已存到 $(ls -1t backups/*.db | head -1)"

echo "▶ 2/5 停容器…"
ssh "$HOST" "cd $REMOTE_DIR && docker compose stop crm"

echo "▶ 3/5 换库文件（连 WAL 一起清掉）…"
scp -q "$SRC" "$HOST:/tmp/restore.db"
ssh "$HOST" "cd $REMOTE_DIR && \
  docker compose cp /tmp/restore.db crm:/data/crm.db && \
  docker compose run --rm --no-deps --entrypoint sh crm -c 'rm -f /data/crm.db-wal /data/crm.db-shm' && \
  rm -f /tmp/restore.db"

echo "▶ 4/5 起容器…"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d crm && sleep 4"

echo "▶ 5/5 校验恢复结果…"
ssh "$HOST" "cd $REMOTE_DIR && docker compose exec -T crm node --experimental-sqlite -e \"
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('/data/crm.db');
for (const t of ['User','Customer','Contract','FollowUp','AuditLog'])
  { try { console.log('  ' + t + ': ' + d.prepare('select count(*) c from ' + t).get().c) } catch { console.log('  ' + t + ': (表不存在)') } }
\"" 2>/dev/null

echo "✅ 恢复完成"
