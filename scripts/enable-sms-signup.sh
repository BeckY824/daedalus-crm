#!/usr/bin/env bash
# 配好短信通道（手机号注册）。
#
#   ./enable-sms-signup.sh <AccessKeyId> <AccessKeySecret> <签名名称> <模板CODE>
#
# 前提（这四样都要先在阿里云控制台办下来，我们代码只负责调接口）：
#   1. 短信服务 → 签名管理，申请一个签名。**国内短信要求域名已备案**，
#      而我们的服务器在香港、域名没备案——这是现在真正的卡点，不是代码。
#   2. 模板管理，申请一个验证码模板。模板里的变量名必须正好是 code，
#      因为代码发的是 {"code":"123456"}。例：您的验证码：${code}，10分钟内有效。
#   3. RAM 用户 + AliyunDysmsFullAccess 权限，拿它的 AccessKey，别用主账号的。
#   4. 账户里有短信条数。
#
# 配好后邮箱和手机号会同时可用：填的像手机号就走短信，像邮箱就走 SMTP。
set -euo pipefail
cd "$(dirname "$0")"

[ $# -eq 4 ] || { sed -n '2,18p' "$0"; exit 1; }
ID=$1; SECRET=$2; SIGN=$3; TPL=$4

cp .env ".env.bak-$(date +%F-%H%M%S)"
sed -i '/^SMS_ACCESS_KEY_ID=/d;/^SMS_ACCESS_KEY_SECRET=/d;/^SMS_SIGN_NAME=/d;/^SMS_TEMPLATE_CODE=/d;/^SIGNUP_REDIRECT=/d;/^SIGNUP_VERIFY=/d' .env
{
  echo ""
  echo "# 短信验证码通道（阿里云）"
  echo "SMS_ACCESS_KEY_ID=$ID"
  echo "SMS_ACCESS_KEY_SECRET=$SECRET"
  echo "SMS_SIGN_NAME=$SIGN"
  echo "SMS_TEMPLATE_CODE=$TPL"
  echo "# 有通道了，注册就顺便要一次验证码"
  echo "SIGNUP_VERIFY=1"
} >> .env
echo "→ 已写入 .env（自助注册恢复，并打开验证码）"

docker compose up -d >/dev/null 2>&1
for i in $(seq 1 30); do sleep 2; [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login || true)" = "200" ] && break; done
echo "→ 已重启"
echo ""
echo "→ 验证：打开 https://app.ai-daedalus.com/signup ，填手机号、点「获取验证码」"
read -rp "→ 做完按回车，我来看日志" _
docker compose logs crm --tail 40 2>&1 | grep -iE "verify|短信" || echo "（日志里没有相关记录）"
echo ""
echo "怎么看："
echo "  有 '[verify] 验证码 target=1xx code=...'  → 短信没发出去，降级到了日志。上面那行会写原因"
echo "  什么都没有                                 → 短信发出去了"
