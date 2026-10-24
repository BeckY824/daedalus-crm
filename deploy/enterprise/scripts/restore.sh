#!/usr/bin/env bash
# 从备份恢复整个数据卷（数据库 + 附件 + 会话密钥）。会覆盖当前数据。
#
#   sudo ./scripts/restore.sh                         # 用最新一份备份
#   sudo ./scripts/restore.sh backups/crm-20261027-033000.tar.gz.enc
#   sudo ./scripts/restore.sh /mnt/nas/crm-20261027-033000.tar.gz.enc
#
# 会先让你输入 RESTORE 确认；无人值守时用 CONFIRM=RESTORE 跳过确认。
# 步骤：先解密校验备份 → 能备就先把当前数据再备一份 → 停应用 → 换数据 → 启动 → 等健康检查。
# 备份密码不是这台机器上的那份时（比如异地恢复）：BACKUP_PASS_FILE=/path/to/pass 指过去。
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need_docker

PASS_FILE="$(backup_pass_file)"
[ -s "$PASS_FILE" ] || die "没有备份密码（$PASS_FILE）。异地恢复时把密码写进一个文件，用 BACKUP_PASS_FILE=该文件 指过去"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$(ls -1t backups/crm-*.tar.gz.enc 2>/dev/null | head -1 || true)"
  [ -n "$SRC" ] || die "backups/ 里没有备份，请指定备份文件"
fi
[ -f "$SRC" ] || die "找不到 $SRC"
SRC="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"

decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE" < "$SRC"; }

say "校验备份 $SRC …"
# 先在不动任何东西的情况下完整读一遍：密码不对、文件损坏都在这一步发现
LIST="$(decrypt 2>/dev/null | tar -tzf - 2>/dev/null)" || die "解不开或文件损坏（密码对吗？）"
printf '%s\n' "$LIST" | grep -x 'crm.db' >/dev/null || die "备份里没有数据库文件，不是本系统的备份？"
ok "备份完好（$(printf '%s\n' "$LIST" | grep -vc '/$') 个文件，$(du -h "$SRC" | cut -f1)）"

if [ "${CONFIRM:-}" != "RESTORE" ]; then
  echo
  echo "将用这份备份覆盖当前所有数据（客户、附件、账号）。"
  printf '确认请输入 RESTORE：'
  read -r ans
  [ "$ans" = "RESTORE" ] || die "已取消"
fi

T0="$(date +%s)"

# 当前数据还在就先备一份，恢复错了还能回来。库已经坏了 / 被删了就备不了，提示后继续
if [ "${SKIP_PREBACKUP:-}" != "1" ]; then
  say "先把当前数据备一份…"
  if "$DEPLOY_DIR/scripts/backup.sh"; then
    :
  else
    warn "当前数据备份失败（库可能已损坏或不存在），继续恢复"
  fi
fi

say "停止应用…"
docker compose stop crm >/dev/null

say "写入数据…"
# 先解到数据卷里的临时目录，确认数据库在，再一次性换掉旧数据：
# 中途失败不会留下新旧混杂的一半数据
decrypt | crm_sh '
  set -e
  rm -rf /data/restore-tmp
  mkdir /data/restore-tmp
  tar -xzf - -C /data/restore-tmp
  [ -f /data/restore-tmp/crm.db ] || { echo "解出来没有 crm.db" >&2; exit 3; }
  find /data -mindepth 1 -maxdepth 1 ! -name restore-tmp -exec rm -rf {} +
  cd /data/restore-tmp
  for f in * .[!.]* ..?*; do if [ -e "$f" ]; then mv "$f" /data/; fi; done
  cd / && rmdir /data/restore-tmp
' || { warn "写入失败，应用仍是停止状态；旧数据可能已部分清掉"; die "请联系我们，或换一份备份重试"; }

say "启动应用…"
docker compose up -d crm >/dev/null
wait_healthy "" 300 || die "应用没能在 5 分钟内启动，看日志：docker compose logs --tail 200 crm"

ok "恢复完成，用时 $(( $(date +%s) - T0 )) 秒（来自 $(basename "$SRC")）"
