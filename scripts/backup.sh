#!/usr/bin/env bash
# 从线上拉一份数据库快照到 backups/。
#
# 必须用 VACUUM INTO 而不是直接复制 crm.db：
# 数据库跑在 WAL 模式下，最近的写入还在 crm.db-wal 里没落盘，
# 直接 cat 出来的文件会丢数据（这个坑踩过一次）。
set -euo pipefail

HOST="${CRM_HOST:?请设置 CRM_HOST，例如 CRM_HOST=root@your-server ./scripts/backup.sh}"
cd "$(dirname "$0")/.."
mkdir -p backups
# 文件名精确到秒。原本只到分钟，同一分钟内备份两次会**静默覆盖**前一次——
# 恢复演练时就撞上了：先备了干净状态，一分钟内又备了一次，
# 干净那份直接没了，而脚本什么都没说。
OUT="backups/crm-$(date +%Y%m%d-%H%M%S).db"
if [ -e "$OUT" ]; then
  echo "!! $OUT 已存在，拒绝覆盖" >&2
  exit 1
fi

cat > /tmp/_snap.js <<'JS'
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
fs.rmSync('/tmp/snapshot.db', { force: true });
new DatabaseSync('/data/crm.db').exec("VACUUM INTO '/tmp/snapshot.db'");
JS

scp -q /tmp/_snap.js "$HOST:/tmp/"
ssh "$HOST" "cd /opt/crm && docker compose cp /tmp/_snap.js crm:/app/_snap.js >/dev/null && docker compose exec -T crm node --experimental-sqlite /app/_snap.js"
ssh "$HOST" "cd /opt/crm && docker compose exec -T crm cat /tmp/snapshot.db" > "$OUT"

echo "已备份 → $OUT ($(du -h "$OUT" | cut -f1))"
node --experimental-sqlite -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('$OUT');
for (const t of ['User','Channel','Customer','Contract','FollowUp'])
  { try { console.log('  '+t+':', d.prepare('select count(*) c from '+t).get().c) } catch {} }
" 2>/dev/null | grep -v -i experimental
