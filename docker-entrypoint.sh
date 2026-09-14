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

# ---------- 托管版（MULTI_TENANT=1）----------
# 单租户部署完全不会走到这里。
if [ "${MULTI_TENANT:-}" = "1" ]; then
  WS_DIR="${WORKSPACE_DIR:-/data/ws}"
  mkdir -p "$WS_DIR"

  # 控制面库：账号、工作区、成员。和业务库分开，见 prisma/control.prisma
  if [ ! -f /data/control.db ]; then
    echo "→ 建控制面库"
    node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync('/data/control.db');
      db.exec(fs.readFileSync('/app/control-schema.sql', 'utf8'));
      db.close();
    "
  fi

  # 控制面的存量迁移。和业务库那套同样的规矩：每次启动整个重跑、只能加表不能改表
  if [ -d /app/control-migrations ]; then
    echo "→ 控制面补迁移"
    node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync('/data/control.db');
      for (const f of fs.readdirSync('/app/control-migrations').filter(f => f.endsWith('.sql')).sort()) {
        try { db.exec(fs.readFileSync('/app/control-migrations/' + f, 'utf8')); }
        catch (e) { if (!/duplicate column name|already exists/i.test(String(e.message))) throw e; }
      }
      db.close();
    "
  fi

  # 模板库：开新工作区时直接复制它。每次启动都重建，保证它反映当前表结构
  echo "→ 生成工作区模板库"
  WS_DIR="$WS_DIR" node --experimental-sqlite -e "
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const out = process.env.WS_DIR + '/_template.db';
    for (const f of [out, out + '-wal', out + '-shm']) fs.rmSync(f, { force: true });
    const db = new DatabaseSync(out);
    db.exec(fs.readFileSync('/app/schema.sql', 'utf8'));
    for (const f of fs.readdirSync('/app/migrations').filter(f => f.endsWith('.sql')).sort()) {
      try { db.exec(fs.readFileSync('/app/migrations/' + f, 'utf8')); }
      catch (e) { if (!/duplicate column name|already exists/i.test(String(e.message))) throw e; }
    }
    db.close();
  "

  # 存量工作区补迁移。漏一个库就是那个租户的页面 500，所以逐个跑、失败要吭声
  for db in "$WS_DIR"/*.db; do
    [ -f "$db" ] || continue
    case "$(basename "$db")" in _template.db) continue ;; esac
    DB="$db" node --experimental-sqlite -e "
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync(process.env.DB);
      for (const f of fs.readdirSync('/app/migrations').filter(f => f.endsWith('.sql')).sort()) {
        try { db.exec(fs.readFileSync('/app/migrations/' + f, 'utf8')); }
        catch (e) { if (!/duplicate column name|already exists/i.test(String(e.message))) throw e; }
      }
      db.close();
    " || { echo "!! 工作区库迁移失败：$db"; exit 1; }
  done
  echo "→ 托管版就绪：$(ls -1 "$WS_DIR"/*.db 2>/dev/null | grep -cv _template || echo 0) 个工作区"
fi

exec "$@"
