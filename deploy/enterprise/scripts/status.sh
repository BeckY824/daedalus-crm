#!/usr/bin/env bash
# 看一眼系统状态：版本、是否健康、最近一次备份、磁盘、证书多久过期、时钟准不准。
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
  echo "最近备份：${LAST}（本机共 $N 份）"
  # 超过两天没成功备份要醒目提示：定时任务可能坏了
  if [ -n "$(find backups/LAST_OK -mmin +2880 2>/dev/null)" ]; then
    warn "已超过 2 天没有成功备份，查 /var/log/crm-backup.log"
  fi
else
  warn "还没有成功的备份"
fi
[ -f /etc/cron.d/crm-backup ] && echo "定时备份：已安装（/etc/cron.d/crm-backup）" || warn "定时备份没有安装（重跑 install.sh 会装上）"
TLS_MODE="$(tls_mode)"
case "$TLS_MODE" in
  own)      echo "HTTPS 证书：贵司自有证书" ;;
  internal) echo "HTTPS 证书：Caddy 内部 CA 签发（浏览器默认不信任；员工电脑装根证书见 scripts/export-root-cert.sh）" ;;
  *)        echo "HTTPS 证书：自动申请（Let's Encrypt）" ;;
esac

echo "磁盘："
# 部署目录和 Docker 数据目录可能不在同一块盘，两块都看；用到 85% 或剩不到 5G 就提示（盘满了数据库写不进、备份也做不了）
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
for d in "$DEPLOY_DIR" "$DOCKER_ROOT"; do
  [ -d "$d" ] || continue
  read -r USED FREE_K < <(df -Pk "$d" | awk 'NR==2 {gsub("%","",$5); print $5, $4}')
  echo "  $d 所在盘 已用 ${USED}%，剩余 $((FREE_K / 1024 / 1024))G"
  if [ "$USED" -ge 85 ] || [ "$FREE_K" -lt 5242880 ]; then
    warn "$d 所在盘快满了：清旧备份（backups/）和旧镜像（docker image prune -a），或者加盘"
  fi
done
docker system df 2>/dev/null | sed 's/^/  /'

# 证书：正在用的那张还有多久过期。自动申请的证书 Caddy 会提前续，剩不到 14 天说明续不上了（80/443 被挡、域名解析改了）
# 内部 CA 签的证书本来就只有约 12 小时、Caddy 自动续，不按 14 天查
DOMAIN="$(env_get DOMAIN)"
if [ -n "$DOMAIN" ] && [ "$TLS_MODE" != internal ] && command -v openssl >/dev/null; then
  SNI=(-servername "$DOMAIN")
  is_ipv4 "$DOMAIN" && SNI=()   # 用 IP 访问时浏览器不带 SNI，这里也不带
  CERT="$(echo | openssl s_client -connect 127.0.0.1:443 "${SNI[@]}" 2>/dev/null | openssl x509 2>/dev/null)"
  if [ -z "$CERT" ]; then
    warn "读不到 https://$DOMAIN 的证书（Caddy 没起来？）"
  else
    echo "证书到期：$(printf '%s\n' "$CERT" | openssl x509 -noout -enddate | cut -d= -f2)"
    if ! printf '%s\n' "$CERT" | openssl x509 -noout -checkend 1209600 >/dev/null; then
      warn "HTTPS 证书 14 天内过期：自有证书请换新的放到 certs/；自动申请的看 docker compose logs caddy"
    fi
  fi
fi

# 时钟：系统时间不准，登录会话、证书校验、备份文件的时间都会乱
if command -v timedatectl >/dev/null; then
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
    echo "系统时间：已和时间服务器同步（$(date '+%Y-%m-%d %H:%M:%S %Z')）"
  else
    warn "系统时间没有和时间服务器同步：sudo timedatectl set-ntp true（内网服务器请配内网 NTP）"
  fi
fi
