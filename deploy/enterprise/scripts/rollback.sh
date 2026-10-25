#!/usr/bin/env bash
# 退回上一个版本（上一次 upgrade.sh 之前的版本）。只换程序，数据保留。
#
#   sudo ./scripts/rollback.sh
#
# 旧镜像还在本机，不用联网。退回后再执行一次 rollback.sh 会回到刚才的新版本。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ -s .previous-version ] || die "没有上一个版本的记录（还没升级过？）"
TARGET="$(cat .previous-version)"
say "退回 $TARGET …"
exec "$DEPLOY_DIR/scripts/upgrade.sh" "$TARGET"
