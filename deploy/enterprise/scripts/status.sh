#!/usr/bin/env bash
# 看一眼系统状态：版本、是否健康、最近一次备份、磁盘。
#
#   sudo ./scripts/status.sh
set -uo pipefail
source "$(dirname "$0")/lib.sh"
need_docker

echo "部署目录：$DEPLOY_DIR"
echo "访问地址：https://$(env_get DOMAIN)"
echo "配置版本：$(env_get CRM_VERSION)    上一版本：$(cat .previous-version 2>/dev/null || echo 无)"
if crm_running; then
  V="$(current_version)"
  if [ -n "$V" ]; then ok "应用运行中，版本 $V"; else warn "容器在跑但健康检查没响应（刚启动？看日志：docker compose logs --tail 100 crm）"; fi
else
  warn "应用没有运行（docker compose up -d 启动）"
fi
docker compose ps --format '  {{.Name}}  {{.Status}}' 2>/dev/null

if [ -f backups/LAST_OK ]; then
  LAST="$(cat backups/LAST_OK)"
  N="$(ls -1 backups/crm-*.tar.gz.enc 2>/dev/null | wc -l | tr -d ' ')"
  echo "最近备份：$LAST（本机共 $N 份）"
  # 超过两天没成功备份要醒目提示：定时任务可能坏了
  if [ -n "$(find backups/LAST_OK -mmin +2880 2>/dev/null)" ]; then
    warn "已超过 2 天没有成功备份，查 /var/log/crm-backup.log"
  fi
else
  warn "还没有成功的备份"
fi
[ -f /etc/cron.d/crm-backup ] && echo "定时备份：已安装（/etc/cron.d/crm-backup）" || warn "定时备份没有安装（重跑 install.sh 会装上）"
[ -s certs/tls.caddy ] && echo "HTTPS 证书：贵司自有证书" || echo "HTTPS 证书：自动申请（Let's Encrypt）"

echo "磁盘："
df -h "$DEPLOY_DIR" | tail -1 | awk '{print "  部署目录所在盘 已用 "$5"，剩余 "$4}'
docker system df 2>/dev/null | sed 's/^/  /'
