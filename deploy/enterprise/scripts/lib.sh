# 各脚本共用的小工具。不单独执行：由其它脚本 source。
# shellcheck shell=bash

# 部署目录 = scripts/ 的上一级；所有脚本先 cd 到这里，docker compose 才找得到 .env
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

say()  { printf '▶ %s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

# 读 .env 里的一项（不 source 整个文件：里面可能有带空格、引号的值）
env_get() {
  [ -f .env ] || return 0
  # 没有这一项时 grep 返回 1，调用方开着 pipefail 会被当成失败退出——没有就是空值
  { grep -E "^$1=" .env || true; } | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# 备份密码文件。命令行临时指定（异地恢复）优先，其次 .env 的 BACKUP_PASS_FILE，默认 secrets/backup.pass
backup_pass_file() {
  local f="${BACKUP_PASS_FILE:-$(env_get BACKUP_PASS_FILE)}"
  echo "${f:-$DEPLOY_DIR/secrets/backup.pass}"
}

# 改 .env 里的一项；没有就追加。写到临时文件再换，写一半断电不会留下半个 .env
env_set() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp "$DEPLOY_DIR/.env.XXXXXX")"
  if [ -f .env ] && grep -qE "^$key=" .env; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp"
  else
    { [ -f .env ] && cat .env; echo "$key=$val"; } > "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" .env
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "没装 Docker。见部署手册「一、准备服务器」"
  docker compose version >/dev/null 2>&1 || die "没有 docker compose 插件。见部署手册「一、准备服务器」"
  docker info >/dev/null 2>&1 || die "连不上 Docker（要用 sudo 执行，或当前用户不在 docker 组）"
}

crm_running() {
  [ "$(docker compose ps --status running -q crm 2>/dev/null)" != "" ]
}

# 在 crm 容器里跑一段 shell。容器在跑就 exec 进去；没跑（比如恢复演练时库已被删、容器起不来）
# 就临时起一个只挂数据卷、不跑应用的容器
crm_sh() {
  if crm_running; then
    docker compose exec -T crm sh -c "$1"
  else
    docker compose run --rm --no-deps -T --entrypoint sh crm -c "$1"
  fi
}

# 等健康检查通过。给了版本号就还要版本对上——换镜像后旧容器可能还在回 200
wait_healthy() {
  local want="${1:-}" timeout="${2:-180}" waited=0 body
  while [ "$waited" -lt "$timeout" ]; do
    body="$(docker compose exec -T crm node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t),()=>{})" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"ok":true'; then
      if [ -z "$want" ] || printf '%s' "$body" | grep -q "\"version\":\"$want\""; then
        return 0
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

current_version() {
  docker compose exec -T crm node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>process.stdout.write(j.version||''),()=>{})" 2>/dev/null || true
}

# 校验 sha256 文件（Ubuntu 用 sha256sum，我方 Mac 打包机用 shasum）
sha256_check() {
  local f="$1"
  ( cd "$(dirname "$f")" && if command -v sha256sum >/dev/null; then sha256sum -c "$(basename "$f")"; else shasum -a 256 -c "$(basename "$f")"; fi ) >/dev/null
}
