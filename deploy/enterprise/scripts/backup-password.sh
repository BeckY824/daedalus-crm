#!/usr/bin/env bash
# 生成备份密码（只需执行一次）。
#
#   sudo ./scripts/backup-password.sh
#
# 密码只存在本机 secrets/backup.pass，脚本不会把它发到任何地方，我们也拿不到。
# 请马上抄一份存到服务器以外（密码管理器 / 保险柜里的纸条）：
# 服务器坏了、硬盘丢了的时候，只有这份密码能解开异地备份。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PASS_FILE="$(backup_pass_file)"
if [ -s "$PASS_FILE" ] && [ "${1:-}" != "--force" ]; then
  ok "已经有备份密码（$PASS_FILE），不重复生成"
  echo "   换新密码：sudo ./scripts/backup-password.sh --force（换了之后旧备份要用旧密码解）"
  exit 0
fi
if [ -s "$PASS_FILE" ]; then
  OLD="$PASS_FILE.old-$(date +%Y%m%d-%H%M%S)"
  cp -p "$PASS_FILE" "$OLD"
  warn "旧密码已另存为 $OLD——之前的备份还要用它解，别删"
fi

mkdir -p "$(dirname "$PASS_FILE")"
chmod 700 "$(dirname "$PASS_FILE")"
umask 077
openssl rand -base64 32 | tr -d '\n' > "$PASS_FILE.tmp"
mv "$PASS_FILE.tmp" "$PASS_FILE"
chmod 600 "$PASS_FILE"

echo
echo "================ 备份密码（只显示这一次）================"
echo
echo "    $(cat "$PASS_FILE")"
echo
echo "========================================================="
echo "请现在就把上面这串抄到服务器以外的地方保管。"
echo "丢了它，所有备份都解不开；我们也无法帮您找回。"
echo
ok "已存到 $PASS_FILE（仅 root 可读）"
