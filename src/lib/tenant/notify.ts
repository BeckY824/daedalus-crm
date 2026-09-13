/**
 * 把验证码送出去。
 *
 * 现在只有两条路：短信（阿里云，等签名审核）和「打印到服务端日志」。
 * 后者不是占位符而是一条正经的过渡方案——签名审核期间我们自己和早期用户
 * 都靠它把号开出来，所以它必须有明确的日志格式，运维一眼能捞到。
 *
 * 绝不把验证码返回给浏览器：那等于任何人都能注册任意手机号。
 * 唯一的例外是本地开发（NODE_ENV !== production），方便自测。
 */

export type SendResult = { ok: true; channel: "sms" | "log" } | { ok: false; error: string };

function smsConfigured(): boolean {
  return Boolean(process.env.SMS_ACCESS_KEY_ID && process.env.SMS_ACCESS_KEY_SECRET && process.env.SMS_SIGN_NAME && process.env.SMS_TEMPLATE_CODE);
}

/** 开发环境下可以把验证码直接回显在页面上，省得去翻日志 */
export function codeVisibleToClient(): boolean {
  return process.env.NODE_ENV !== "production" && !smsConfigured();
}

export async function sendCode(target: string, code: string): Promise<SendResult> {
  if (smsConfigured()) {
    try {
      return await sendSms(target, code);
    } catch (e) {
      // 短信挂了不该让人注册不了：降级到日志，运维能从日志里把码捞给用户
      console.error("[verify] 短信发送失败，降级到日志：", e instanceof Error ? e.message : e);
    }
  }
  console.info(`[verify] 验证码 target=${target} code=${code}`);
  return { ok: true, channel: "log" };
}

/**
 * 阿里云短信。用 RPC 签名，不引 SDK——只调一个接口，为它拖一个包不划算。
 * 签名算法见阿里云文档「RPC 接口签名」。
 */
async function sendSms(phone: string, code: string): Promise<SendResult> {
  const { createHmac, randomUUID } = await import("node:crypto");
  const params: Record<string, string> = {
    AccessKeyId: process.env.SMS_ACCESS_KEY_ID!,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: phone,
    RegionId: "cn-hangzhou",
    SignName: process.env.SMS_SIGN_NAME!,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: process.env.SMS_TEMPLATE_CODE!,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}/, ""),
    Version: "2017-05-25",
  };
  const esc = (v: string) => encodeURIComponent(v).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~");
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${esc(k)}=${esc(params[k])}`)
    .join("&");
  const toSign = `GET&${esc("/")}&${esc(canonical)}`;
  const sig = createHmac("sha1", `${process.env.SMS_ACCESS_KEY_SECRET!}&`).update(toSign).digest("base64");

  const res = await fetch(`https://dysmsapi.aliyuncs.com/?Signature=${esc(sig)}&${canonical}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as { Code?: string; Message?: string };
  if (data.Code !== "OK") return { ok: false, error: data.Message ?? "短信发送失败" };
  return { ok: true, channel: "sms" };
}
