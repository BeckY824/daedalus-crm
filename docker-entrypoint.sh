#!/bin/sh
# 容器入口：零配置也能起。
#   - 没传 AUTH_SECRET → 第一次生成一个随机密钥存进数据卷，之后每次启动复用
#   - 首次启动没传 INIT_PASSWORD → 生成一个随机密码，打印在日志里
#   - 库不存在 → 建表并写入账号；存在 → 只跑幂等迁移
set -e
mkdir -p /data

# 会话密钥。显式传的优先；否则用数据卷里保存的；都没有就生成。
# 密钥同时用于加密存储的 AI Key，所以要和数据放在一起——迁移机器时把 /data 整个带走即可。
if [ -z "${AUTH_SECRET:-}" ]; then
  if [ ! -f /data/.auth-secret ]; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64'))" > /data/.auth-secret
    chmod 600 /data/.auth-secret
    echo "→ 已生成会话密钥，保存在数据卷 /data/.auth-secret"
  fi
  AUTH_SECRET="$(cat /data/.auth-secret)"
  export AUTH_SECRET
fi

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
  GENERATED_PASSWORD=""
  if [ -z "${INIT_PASSWORD:-}" ]; then
    # 不带默认密码出厂：没传就随机生成一个，只在这次日志里出现一回
    INIT_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(9).toString('base64url'))")"
    export INIT_PASSWORD
    GENERATED_PASSWORD="$INIT_PASSWORD"
  fi
  echo "→ 建表"
  node --experimental-sqlite -e "
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync('/data/crm.db');
    db.exec(fs.readFileSync('/app/schema.sql', 'utf8'));
    db.close();
  " 2>/dev/null
  echo "→ 写入初始数据"
  QUIET_PASSWORD=1 node seed.js
  echo "→ 初始化完成"
  if [ -n "$GENERATED_PASSWORD" ]; then
    echo ""
    echo "=================================================="
    echo "  管理员账号：admin"
    echo "  初始密码：$GENERATED_PASSWORD"
    echo "  登录后请到「设置管理 → 修改密码」改掉。"
    echo "  这段只打印这一次；忘了可用 RESET_PASSWORDS=1 重置（见 docs/部署.md）"
    echo "=================================================="
    echo ""
  fi
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
    " 2>/dev/null
  done
fi

exec "$@"
