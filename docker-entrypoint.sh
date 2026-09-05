#!/bin/sh
set -e
mkdir -p /data

# 表结构变更时，用 REBUILD_DB=1 显式重建。
# 不做自动判断：静默重建生产库等于随时可能丢数据，必须人为确认。
if [ "${REBUILD_DB:-}" = "1" ]; then
  echo "→ REBUILD_DB=1：备份并重建数据库"
  if [ -f /data/crm.db ]; then
    STAMP=$(date +%Y%m%d-%H%M%S)
    node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      // WAL 模式下要用 VACUUM INTO 才能拿到完整快照
      new DatabaseSync('/data/crm.db').exec(\"VACUUM INTO '/data/pre-rebuild-${STAMP}.db'\");
    " 2>/dev/null
    echo "  旧库已备份为 /data/pre-rebuild-${STAMP}.db"
    rm -f /data/crm.db /data/crm.db-wal /data/crm.db-shm
  fi
fi

if [ ! -f /data/crm.db ]; then
  # 首次启动会创建 admin 账号。不允许带默认密码启动：
  # 一个公开的默认密码等于每个没改密码的实例都是公开的。
  if [ -z "${INIT_PASSWORD:-}" ]; then
    echo "✗ 首次启动必须设置 INIT_PASSWORD（管理员初始密码，至少 8 位）。" >&2
    echo "  例：INIT_PASSWORD=你的密码 docker compose up -d" >&2
    exit 1
  fi
  echo "→ 建表"
  node --experimental-sqlite -e "
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync('/data/crm.db');
    db.exec(fs.readFileSync('/app/schema.sql', 'utf8'));
    db.close();
  "
  echo "→ 写入初始数据"
  node seed.js
  echo "→ 初始化完成"
else
  echo "→ 使用已有数据库"
fi

# 增量迁移：按文件名顺序把 migrations/ 全部重跑一遍。
# 里面每条语句都是幂等的（IF NOT EXISTS），所以不需要记录「执行到哪了」——
# 少一套状态就少一处会和真实表结构对不上的地方。
# 全新安装其实已经由 schema.sql 建全了，这里跑一遍是空转，无副作用。
if [ -d /app/migrations ]; then
  for f in /app/migrations/*.sql; do
    [ -f "$f" ] || continue
    echo "→ 迁移 $(basename "$f")"
    node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync('/data/crm.db');
      db.exec(fs.readFileSync('$f', 'utf8'));
      db.close();
    "
  done
fi

exec "$@"
