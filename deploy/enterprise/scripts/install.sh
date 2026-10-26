#!/usr/bin/env bash
# 第一次安装。重复执行是安全的：已有的 .env、备份密码、数据都不会被覆盖。
#
#   sudo ./scripts/install.sh                                   # 在线安装，会问域名或 IP
#   sudo ./scripts/install.sh --domain crm.example.com
#   sudo ./scripts/install.sh --domain 10.0.0.8                 # 没有域名：用服务器 IP，证书由内置 CA 自签
#   sudo ./scripts/install.sh --load crm-images-0.47.0.tar.gz   # 离线：先导入我们发的镜像包
#
# 做的事：检查服务器 → （离线时）导入镜像 → 生成 .env 和管理员密码 → 生成备份密码
#        → （用 IP 时）改用内置 CA 证书 → 启动 → 等健康检查 → 装每日备份定时任务
#        → 打印管理员密码（只显示一次）
set -euo pipefail
source "$(dirname "$0")/lib.sh"

DOMAIN_ARG="" BUNDLE="" VERSION_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)  DOMAIN_ARG="${2:-}"; shift 2 ;;
    --load)    BUNDLE="${2:-}"; shift 2 ;;
    --version) VERSION_ARG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "不认识的参数 $1（--help 看用法）" ;;
  esac
done

# ── 1. 检查服务器 ─────────────────────────────────────
say "检查服务器…"
LINUX=0; [ "$(uname -s)" = "Linux" ] && LINUX=1
if [ "$LINUX" = 1 ]; then
  [ "$(id -u)" = 0 ] || die "请用 sudo 执行"
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}-${VERSION_ID:-}" in
      ubuntu-22.04|ubuntu-24.04) ;;
      *) warn "推荐 Ubuntu 22.04 / 24.04，当前是 ${PRETTY_NAME:-未知}，可能遇到未验证的问题" ;;
    esac
  fi
  CPUS="$(nproc)"
  MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
  [ "$CPUS" -ge 2 ] || warn "CPU $CPUS 核，推荐至少 2 核"
  [ "$MEM_MB" -ge 3500 ] || warn "内存 ${MEM_MB}MB，推荐至少 4GB"
else
  warn "不是 Linux（$(uname -s)），只适合试跑：不装定时备份"
fi
need_docker
FREE_GB="$(df -Pk "$DEPLOY_DIR" | awk 'NR==2 {print int($4/1024/1024)}')"
[ "$FREE_GB" -ge 20 ] || warn "部署目录所在盘只剩 ${FREE_GB}GB，推荐至少 40GB 的盘（备份也占地方）"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)，$(docker compose version --short 2>/dev/null) 版 compose"

# ── 2. 离线镜像 ───────────────────────────────────────
LOADED_VERSION=""
if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "找不到镜像包 $BUNDLE"
  if [ -f "$BUNDLE.sha256" ]; then
    say "校验镜像包…"
    sha256_check "$BUNDLE.sha256" || die "镜像包校验不通过，可能传输不完整，请重新上传"
  fi
  say "导入镜像（几分钟）…"
  LOADED="$(gunzip -c "$BUNDLE" | docker load)" || die "镜像导入失败"
  printf '%s\n' "$LOADED"
  IMG="$(env_get CRM_IMAGE)"; IMG="${IMG:-ghcr.io/becky824/daedalus-crm}"
  LOADED_VERSION="$(printf '%s\n' "$LOADED" | sed -n "s|^Loaded image: $IMG:||p" | head -1)"
fi

# ── 3. .env ──────────────────────────────────────────
if [ ! -f .env ]; then
  say "生成配置 .env …"
  VERSION="${VERSION_ARG:-${LOADED_VERSION:-$(cat VERSION 2>/dev/null || true)}}"
  [ -n "$VERSION" ] || die "不知道装哪个版本：用 --version 指定，或用我们发的部署包（里面有 VERSION 文件）"
  DOMAIN="$DOMAIN_ARG"
  if [ -z "$DOMAIN" ]; then
    echo '贵司给 CRM 用的域名或 IP：'
    echo '  有域名：填域名，如 crm.example.com（要先解析到本机公网 IP），自动申请正式证书'
    echo '  没域名：填这台服务器的 IP，如 10.0.0.8（员工从哪个地址访问就填哪个），证书由内置 CA 自签'
    printf '域名或 IP：'
    read -r DOMAIN
  fi
  DOMAIN="$(normalize_host "$DOMAIN")" || exit 1

  umask 077
  cp .env.example .env
  chmod 600 .env
  env_set CRM_VERSION "$VERSION"
  env_set DOMAIN "$DOMAIN"
  # 去掉容易抄错的字符；14 位足够首次登录用，登录后要求改掉
  env_set INIT_PASSWORD "$(openssl rand -base64 24 | tr -d '/+=OIl01' | cut -c1-14)"
else
  ok "已有 .env，沿用（要改域名等配置直接编辑 .env 再 docker compose up -d）"
  [ -z "$VERSION_ARG$LOADED_VERSION" ] || warn "已安装过，--version / --load 的版本不会生效；升级请用 scripts/upgrade.sh"
fi
mkdir -p certs secrets backups
chmod 700 secrets backups

# 用 IP 访问：公网证书机构不给 IP 发证书，改由 Caddy 内置 CA 签发（见 Caddyfile）。
# 已经有 tls.caddy（换过自有证书）就不动
if is_ipv4 "$(env_get DOMAIN)" && [ ! -s certs/tls.caddy ]; then
  echo 'tls internal' > certs/tls.caddy
  chmod 644 certs/tls.caddy
  ok "用 IP 访问：HTTPS 证书由内置 CA 签发（浏览器会提示不受信任，见手册「四、HTTPS 证书」）"
fi

# ── 4. 备份密码 ───────────────────────────────────────
if [ ! -s "$(backup_pass_file)" ]; then
  "$DEPLOY_DIR/scripts/backup-password.sh"
  if [ -t 0 ]; then
    printf '抄好备份密码后按回车继续…'
    read -r _
  fi
fi

# ── 5. 启动 ──────────────────────────────────────────
say "启动（首次要拉镜像、建库，一两分钟）…"
docker compose up -d
wait_healthy "$(env_get CRM_VERSION)" 300 || die "应用没能在 5 分钟内启动，看日志：docker compose logs --tail 200 crm"
ok "应用已启动"

# ── 6. 每日备份 ───────────────────────────────────────
if [ "$LINUX" = 1 ]; then
  # 云厂商的 Ubuntu 镜像都自带 cron；精简版没有时定时文件写了也不会跑
  command -v cron >/dev/null 2>&1 || warn "没装 cron，每日备份不会跑：sudo apt install -y cron"
  mkdir -p /etc/cron.d
  cat > /etc/cron.d/crm-backup <<CRON
# 企业版 CRM 每日备份（由 $DEPLOY_DIR/scripts/install.sh 生成）
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root cd "$DEPLOY_DIR" && ./scripts/backup.sh >> /var/log/crm-backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/crm-backup
  ok "已装每日 03:30 自动备份（日志 /var/log/crm-backup.log）"
fi

# ── 7. 结果 ──────────────────────────────────────────
DOMAIN="$(env_get DOMAIN)"
PASS="$(env_get INIT_PASSWORD)"
echo
echo "=================================================="
echo "  访问地址：https://$DOMAIN"
# 判断 .env 里还有没有密码而不是「是不是第一次」：上次装到一半失败、密码还没显示过，重跑要能看到
if [ -n "$PASS" ]; then
  echo "  管理员账号：admin"
  echo "  初始密码：  $PASS"
  echo "  登录后请马上到「设置管理 → 修改密码」改掉。这段只显示这一次。"
fi
if [ "$(tls_mode)" = internal ] && [ "$DOMAIN" != localhost ]; then
  echo
  echo "  证书是内置 CA 自签的：浏览器第一次打开会提示「不安全 / 证书不受信任」。"
  echo "  员工电脑装一次根证书就不再提示：sudo ./scripts/export-root-cert.sh（手册「四」）"
  echo "  或者换成贵司自己的证书：sudo ./scripts/use-own-cert.sh"
fi
echo "=================================================="
# 库已建好，初始密码不再起作用；不把明文密码留在磁盘上
[ -z "$PASS" ] || env_set INIT_PASSWORD ""
echo
echo "下一步：先手动备份一次确认能跑通 —— sudo ./scripts/backup.sh"
