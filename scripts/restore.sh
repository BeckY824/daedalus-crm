#!/usr/bin/env bash
# 从备份文件恢复数据库。在跑着 docker compose 的那台机器上执行：
#
#   CONFIRM=RESTORE ./scripts/restore.sh backups/crm-20260905-120000.db
#
# 这是**破坏性操作**：当前数据会被整个替换。必须显式带 CONFIRM=RESTORE，
# 脚本会先自动备份一份当前状态再动手。
#
# 两个坑：
#   1. 数据库跑在 WAL 模式下，crm.db 旁边还有 crm.db-wal / crm.db-shm。
#      只换 crm.db 不删这两个，SQLite 起来会把旧 WAL 重放到新文件上——
#      表现是「恢复完了数据还是错的」。
#   2. 必须先停容器再换文件，运行中的进程还握着旧文件。
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-}"

if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "用法：CONFIRM=RESTORE $0 <备份文件>"
  ls -1t backups/*.db 2>/dev/null | head -10 || echo "  （backups/ 下没有备份）"
  exit 1
fi
if [ "${CONFIRM:-}" != "RESTORE" ]; then
  echo "!! 这会用 $SRC 覆盖当前数据库，现有数据将全部丢失。确认请带 CONFIRM=RESTORE 重新执行。"
  exit 1
fi

echo "▶ 1/4 先备份当前状态（恢复错了还能回来）…"
./scripts/backup.sh
echo "▶ 2/4 停容器…"
docker compose stop crm
echo "▶ 3/4 换库文件（连 WAL 一起清掉）…"
docker compose cp "$SRC" crm:/data/crm.db
docker compose run --rm --no-deps --entrypoint sh crm -c 'rm -f /data/crm.db-wal /data/crm.db-shm'
echo "▶ 4/4 起容器…"
docker compose up -d crm
echo "✅ 恢复完成"
