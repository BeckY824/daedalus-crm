#!/usr/bin/env bash
# 备份数据库到 backups/。在跑着 docker compose 的那台机器上执行：
#
#   ./scripts/backup.sh
#
# 必须用 VACUUM INTO 而不是直接复制 crm.db：
# 数据库跑在 WAL 模式下，最近的写入还在 crm.db-wal 里没落盘，直接拷出来会丢数据。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
# 文件名精确到秒：同一分钟内备份两次不能静默覆盖前一次
OUT="backups/crm-$(date +%Y%m%d-%H%M%S).db"
if [ -e "$OUT" ]; then
  echo "!! $OUT 已存在，拒绝覆盖" >&2
  exit 1
fi

docker compose exec -T crm node --experimental-sqlite -e "
  const { DatabaseSync } = require('node:sqlite');
  require('node:fs').rmSync('/tmp/snapshot.db', { force: true });
  new DatabaseSync('/data/crm.db').exec(\"VACUUM INTO '/tmp/snapshot.db'\");
" 2>/dev/null
docker compose exec -T crm cat /tmp/snapshot.db > "$OUT"
echo "已备份 → $OUT ($(du -h "$OUT" | cut -f1))"
