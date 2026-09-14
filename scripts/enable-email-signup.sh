#!/usr/bin/env bash
# 配好邮件通道并打开自助注册。
#
#   ./enable-email-signup.sh <SMTP主机> <端口> <用户名> <密码> <发件人> [--verify]
#
# 例（阿里云邮件推送）：
#   ./enable-email-signup.sh smtpdm.aliyun.com 465 no-reply@mail.你的域名 '你的SMTP密码' 'Daedalus CRM <no-reply@mail.你的域名>'
#
# 注册本身**不需要**这个：默认填账号密码就能注册，通道配不配都一样。
# 配它是为了将来能发密码找回这类信。
#
# **默认不会打开验证码。** 想让注册也要一次验证码（多证明一步「这个号是你的」），
# 在最后加 --verify。加了之后没收到信的人就注册不了，想清楚再加。
# 密码只出现在这台机器上，不会被打印。
set -euo pipefail
cd "$(dirname "$0")"

[ $# -eq 5 ] || [ $# -eq 6 ] || { sed -n '2,12p' "$0"; exit 1; }
HOST=$1; PORT=$2; USER=$3; PASS=$4; FROM=$5
VERIFY=""
[ "${6:-}" = "--verify" ] && VERIFY=1

cp .env ".env.bak-$(date +%F-%H%M%S)"
# 先删掉可能已有的同名键，再追加，免得 .env 里出现两份
sed -i '/^SMTP_HOST=/d;/^SMTP_PORT=/d;/^SMTP_USER=/d;/^SMTP_PASS=/d;/^SMTP_FROM=/d;/^SIGNUP_REDIRECT=/d;/^SIGNUP_VERIFY=/d' .env
{
  echo ""
  echo "# 邮件验证码通道"
  echo "SMTP_HOST=$HOST"
  echo "SMTP_PORT=$PORT"
  echo "SMTP_USER=$USER"
  echo "SMTP_PASS=$PASS"
  echo "SMTP_FROM=$FROM"
  [ -n "$VERIFY" ] && { echo "# 注册时要一次验证码"; echo "SIGNUP_VERIFY=1"; }
} >> .env
echo "→ 已写入 .env（自助注册恢复${VERIFY:+，并打开了验证码}）"

docker compose up -d >/dev/null 2>&1
echo "→ 已重启，等服务就绪"
for i in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login || true)
  [ "$code" = "200" ] && break
done

# 验证走真实路径，不单独 require nodemailer——它被 Next 打进了 server chunk，
# 容器里没有独立的 node_modules/nodemailer，单独 require 一定失败，会误判成"通道坏了"。
echo ""
echo "→ 现在验证：打开 https://app.ai-daedalus.com/signup ，填你的邮箱、点「获取验证码」"
# 非交互（比如从别的机器 ssh 过来跑）时不要卡在这里
if [ -t 0 ]; then read -rp "→ 做完按回车，我来看日志" _; fi
echo ""
docker compose logs crm --tail 40 2>&1 | grep -i verify || echo "（日志里没有 verify 记录）"
echo ""
echo "怎么看这段日志："
echo "  有 '[verify] 验证码 target=... code=...'  → 邮件没发出去，降级到了日志。看上面有没有「邮件发送失败」"
echo "  什么都没有                                  → 邮件正常发出去了，去收件箱（和垃圾箱）找"
echo ""
echo "→ 现在去 https://app.ai-daedalus.com/signup 走一遍：填邮箱 → 获取验证码 → 应该收到信"
echo "→ 万一没收到，看日志里有没有降级记录：docker compose logs crm | grep verify"
