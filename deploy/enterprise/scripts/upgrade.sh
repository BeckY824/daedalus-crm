#!/usr/bin/env bash
# 升级到新版本。失败会自动退回原版本。
#
#   sudo ./scripts/upgrade.sh 0.47.0                        # 在线：从镜像仓库拉
#   sudo ./scripts/upgrade.sh --load crm-images-0.47.0.tar.gz  # 离线：用我们发的镜像包
#
# 步骤：备份 → 拉取 / 导入新镜像 → 改 .env 里的 CRM_VERSION → 重启 → 等健康检查且版本号对上。
# 任何一步失败都退回原版本；数据库只会加表加列，旧版本能直接跑在升级过的库上。
# 真要连数据一起退回：sudo ./scripts/restore.sh <升级前那份备份>（升级时会打印文件名）。
#
# 回滚到上一个版本：sudo ./scripts/rollback.sh
set -euo pipefail
source "$(dirname "$0")/lib.sh"
need_docker

IMAGE="$(env_get CRM_IMAGE)"; IMAGE="${IMAGE:-ghcr.io/becky824/daedalus-crm}"
PREV="$(env_get CRM_VERSION)"
[ -n "$PREV" ] || die ".env 里没有 CRM_VERSION，先执行 install.sh"

case "${1:-}" in
  "" | -h | --help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1 ;;
  --load)
    BUNDLE="${2:-}"
    [ -f "$BUNDLE" ] || die "找不到镜像包 $BUNDLE"
    if [ -f "$BUNDLE.sha256" ]; then
      say "校验镜像包…"
      sha256_check "$BUNDLE.sha256" || die "镜像包校验不通过，可能传输不完整，请重新上传"
    fi
    say "导入镜像（几分钟）…"
    LOADED="$(gunzip -c "$BUNDLE" | docker load)" || die "镜像导入失败"
    printf '%s\n' "$LOADED"
    NEW="$(printf '%s\n' "$LOADED" | sed -n "s|^Loaded image: $IMAGE:||p" | head -1)"
    [ -n "$NEW" ] || die "镜像包里没有 $IMAGE 的镜像"
    ;;
  *)
    NEW="$1" ;;
esac

[ "$NEW" != "$PREV" ] || { ok "已经是 ${NEW}，不用升级"; exit 0; }

if ! docker image inspect "$IMAGE:$NEW" >/dev/null 2>&1; then
  say "拉取 $IMAGE:$NEW …"
  docker pull "$IMAGE:$NEW" || die "拉取失败（网络不通时改用离线镜像包：upgrade.sh --load）"
fi

if [ "${SKIP_BACKUP:-}" != "1" ]; then
  say "升级前备份…"
  "$DEPLOY_DIR/scripts/backup.sh" || die "备份失败，没有升级。确认备份能跑通再升级（实在要跳过：SKIP_BACKUP=1）"
  PRE_BACKUP="$(ls -1t backups/crm-*.tar.gz.enc | head -1)"
fi

# 失败退回时把 .previous-version 还原，免得 rollback 指向一个没跑起来的版本
OLD_PREVIOUS="$(cat .previous-version 2>/dev/null || true)"
echo "$PREV" > .previous-version
TIMEOUT="${UPGRADE_TIMEOUT:-300}"
say "$PREV → ${NEW}：重启应用…"
env_set CRM_VERSION "$NEW"
docker compose up -d >/dev/null

if wait_healthy "$NEW" "$TIMEOUT"; then
  ok "已升级到 ${NEW}（上一版 ${PREV}；回滚：sudo ./scripts/rollback.sh）"
  [ -n "${PRE_BACKUP:-}" ] && echo "   升级前备份：$PRE_BACKUP"
  exit 0
fi

warn "新版本 $((TIMEOUT / 60)) 分钟内没通过健康检查，退回 $PREV …"
docker compose logs --tail 80 crm >&2 || true
env_set CRM_VERSION "$PREV"
if [ -n "$OLD_PREVIOUS" ]; then echo "$OLD_PREVIOUS" > .previous-version; else rm -f .previous-version; fi
docker compose up -d >/dev/null
if wait_healthy "$PREV" 300; then
  die "升级失败，已退回 ${PREV}，数据未动。请把上面的日志发给我们"
fi
die "升级失败，退回 $PREV 也没起来。请保留现场联系我们；升级前备份：${PRE_BACKUP:-无}"
