#!/usr/bin/env bash
# 【我方用，不发给客户】打企业版交付包。
#
#   deploy/enterprise/tools/pack.sh 0.47.0 [输出目录，默认 dist/enterprise-0.47.0]
#
# 产出：
#   crm-enterprise-<版本>.tar.gz          部署包（compose、Caddyfile、脚本、手册），解压即用
#   crm-images-<版本>.tar.gz              离线镜像包（linux/amd64：应用 + Caddy），服务器上不能联网拉镜像时用
#   *.sha256                              对应校验文件，和包放在一起上传，脚本会自动校验
#
# 镜像要先在 GHCR 上发布好（发版流程会推）。这里只拉取、导出，不构建。
set -euo pipefail

VER="${1:?用法：pack.sh <版本号> [输出目录]}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${2:-$ROOT/dist/enterprise-$VER}"
IMAGE="${CRM_IMAGE:-ghcr.io/becky824/daedalus-crm}"
CADDY="${CADDY_IMAGE:-caddy:2-alpine}"
PLATFORM="${PLATFORM:-linux/amd64}"

sha() { ( cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi > "$1.sha256" ); }

mkdir -p "$OUT"
echo "▶ 部署包…"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/crm-enterprise/certs"
cp "$HERE/docker-compose.yml" "$HERE/Caddyfile" "$HERE/.env.example" "$HERE/README.md" "$STAGE/crm-enterprise/"
cp -R "$HERE/scripts" "$STAGE/crm-enterprise/"
echo "$VER" > "$STAGE/crm-enterprise/VERSION"
touch "$STAGE/crm-enterprise/certs/.keep"
# 打包机是 Mac 时别带上 ._ 资源文件和扩展属性
COPYFILE_DISABLE=1 tar -czf "$OUT/crm-enterprise-$VER.tar.gz" -C "$STAGE" crm-enterprise
sha "crm-enterprise-$VER.tar.gz"

echo "▶ 拉取 $PLATFORM 镜像…"
docker pull --platform "$PLATFORM" "$IMAGE:$VER"
docker pull --platform "$PLATFORM" "$CADDY"
echo "▶ 导出离线镜像包（几分钟）…"
docker save --platform "$PLATFORM" "$IMAGE:$VER" "$CADDY" | gzip > "$OUT/crm-images-$VER.tar.gz"
sha "crm-images-$VER.tar.gz"

echo "✅ $OUT"
ls -lh "$OUT"
