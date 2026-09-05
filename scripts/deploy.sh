#!/usr/bin/env bash
# 部署到远端服务器：镜像在本机交叉构建（小内存服务器跑 Next 构建会 OOM），
# 打包后经 SSH 传输，服务器只负责运行。
#
#   CRM_HOST=root@your-server ./scripts/deploy.sh
set -euo pipefail

HOST="${CRM_HOST:?请设置 CRM_HOST，例如 CRM_HOST=root@your-server ./scripts/deploy.sh}"
REMOTE_DIR=/opt/crm
IMAGE=daedalus-crm:latest
# 目标服务器架构；在 Apple Silicon 上给 x86 服务器构建就需要它
PLATFORM="${PLATFORM:-linux/amd64}"
# 保留几个历史版本可供回滚。2G 轻量实例磁盘不宽裕，不要调太大
KEEP=5

cd "$(dirname "$0")/.."

# 版本 tag：没有它就没有回滚可言——compose 引用的是 daedalus-crm:latest，
# 每次 docker load 都把它覆盖掉，上一版会变成认不出来的 <none> 镜像，
# 随时可能被 docker image prune 清走。
REV="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  # 工作区不干净时，镜像内容和这个 commit 并不对应。标出来，
  # 免得回滚时按 sha 找版本却拿到一个对不上的镜像
  REV="${REV}-dirty"
  echo "⚠ 工作区有未提交改动，本次镜像标记为 ${REV}"
fi
VERSION="daedalus-crm:${REV}"

echo "▶ 1/4 本地构建 ${PLATFORM} 镜像（${REV}）…"
docker buildx build --platform "$PLATFORM" -t "$IMAGE" -t "$VERSION" --load .

echo "▶ 2/4 同步 compose 与 Caddy 配置…"
ssh "$HOST" "mkdir -p $REMOTE_DIR"
# Caddyfile 此前一直没被同步，改了本地也不会生效——
# 反代配置和应用是一起演进的（比如 X-Forwarded-For 的处理），必须一起发
scp -q docker-compose.yml docker-compose.caddy.yml Caddyfile "$HOST:$REMOTE_DIR/"

echo "▶ 3/4 传输镜像（压缩后约 200MB，首次较慢）…"
# 两个 tag 指向同一镜像，层只传一份，体积不变
docker save "$IMAGE" "$VERSION" | gzip -1 | ssh "$HOST" "gunzip | docker load"

echo "▶ 4/4 重启服务…"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --no-build && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null; sleep 5 && docker compose ps"

echo "▶ 清理超出保留数的旧版本…"
# 只删带 sha tag 的历史镜像，不碰 latest 与正在运行的那个
ssh "$HOST" "docker images daedalus-crm --format '{{.Tag}} {{.ID}}' | grep -v '^latest ' | tail -n +$((KEEP + 1)) | awk '{print \"daedalus-crm:\" \$1}' | xargs -r docker rmi 2>/dev/null || true"

echo
echo "✅ 完成 → http://${HOST#*@}   本次版本 ${REV}"
echo
echo "可回滚到的版本："
# 缩进在本地加：前导空格经 ssh 传过去会被吃掉，远端的 grep 就匹配不上了
ssh "$HOST" "docker images daedalus-crm --format '{{.Tag}}\t{{.CreatedAt}}' | grep -v '^latest'" | sed 's/^/  /' 
echo
echo "回滚：ssh $HOST \"cd $REMOTE_DIR && docker tag daedalus-crm:<版本> daedalus-crm:latest && docker compose up -d --no-build\""
