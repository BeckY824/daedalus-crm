/**
 * 官网预约演示表单的后端。规则在 lib/lead.ts，这里钉 HTTP 边界和四道闸：
 * 只认官网 Origin、蜜罐命中装作成功、每 IP 每天几条、全站每天封顶——
 * 这个接口不要凭证、会花我们的邮件额度（注册码也从同一条通道出），任何一道漏了
 * 都能让人把当天的注册码打没。另外钉 Reply-To 是访客邮箱：发件地址收不了信。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { 设置发送器, 每IP每日线索上限, 每日线索总上限, type 邮件 } from "@/lib/lead";
import { 重置注册计数 } from "@/lib/rate-limit";

const 官网 = "https://ai-daedalus.com";
let 发出的: 邮件[] = [];

beforeEach(() => {
  重置注册计数();
  发出的 = [];
  设置发送器(async (m) => { 发出的.push(m); });
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
  process.env.SMTP_FROM = "Daedalus CRM <no-reply@example.com>";
  delete process.env.LEAD_TO;
  delete process.env.LEGAL_CONTACT;
  delete process.env.LEAD_ORIGINS;
});

afterAll(() => {
  设置发送器(null);
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"]) delete process.env[k];
});

const 完整 = { name: "张三", phone: "13800000000", company: "某某科技", title: "IT 经理", teamsize: "21-100", email: "zhangsan@example.com", scenario: "客户跟进" };

function 发(body: unknown, { origin = 官网, ip = "203.0.113.7" }: { origin?: string | null; ip?: string | null } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (ip) headers["x-forwarded-for"] = `1.1.1.1, ${ip}`;
  return new Request("https://app.example.com/api/lead", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("/api/lead", () => {
  it("正常提交：200，邮件到收件箱，Reply-To 是访客", async () => {
    const { POST } = await import("@/app/api/lead/route");
    const res = await POST(发(完整));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(官网);
    expect(发出的).toHaveLength(1);
    const m = 发出的[0];
    expect(m.to).toBe("qy1g18@gmail.com");
    expect(m.replyTo).toBe("张三 <zhangsan@example.com>");
    expect(m.subject).toBe("预约演示 - 某某科技");
    expect(m.text).toContain("手机号：13800000000");
    expect(m.text).toContain("关注场景：客户跟进");
  });

  it("英文站的邮件用英文标签", async () => {
    const { POST } = await import("@/app/api/lead/route");
    await POST(发({ ...完整, lang: "en", title: "" }));
    expect(发出的[0].subject).toBe("Demo request - 某某科技");
    expect(发出的[0].text).toContain("Role：-");
  });

  it("收件箱可以用 LEAD_TO 或 LEGAL_CONTACT 改", async () => {
    const { POST } = await import("@/app/api/lead/route");
    process.env.LEGAL_CONTACT = "legal@example.com";
    await POST(发(完整));
    process.env.LEAD_TO = "sales@example.com";
    await POST(发(完整));
    expect(发出的.map((m) => m.to)).toEqual(["legal@example.com", "sales@example.com"]);
  });

  it("来源不是官网：403，什么都不发；预检同样", async () => {
    const { POST, OPTIONS } = await import("@/app/api/lead/route");
    expect((await POST(发(完整, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(发(完整, { origin: null }))).status).toBe(403);
    expect(发出的).toHaveLength(0);
    const 预检 = await OPTIONS(new Request("https://app.example.com/api/lead", { method: "OPTIONS", headers: { Origin: 官网 } }));
    expect(预检.status).toBe(204);
    expect(预检.headers.get("access-control-allow-methods")).toContain("POST");
    expect((await OPTIONS(new Request("https://app.example.com/api/lead", { method: "OPTIONS" }))).status).toBe(403);
  });

  it("LEAD_ORIGINS 能追加来源", async () => {
    process.env.LEAD_ORIGINS = "http://localhost:8080";
    const { POST } = await import("@/app/api/lead/route");
    expect((await POST(发(完整, { origin: "http://localhost:8080" }))).status).toBe(200);
  });

  it("蜜罐被填：回 200 装作收下，实际不发", async () => {
    const { POST } = await import("@/app/api/lead/route");
    const res = await POST(发({ ...完整, website: "http://spam.example" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(发出的).toHaveLength(0);
  });

  it("字段不对：400，不发", async () => {
    const { POST } = await import("@/app/api/lead/route");
    expect((await POST(发({ ...完整, email: "不是邮箱" }))).status).toBe(400);
    expect((await POST(发({ ...完整, company: "  " }))).status).toBe(400);
    expect((await POST(发({ ...完整, name: 42 }))).status).toBe(400);
    expect((await POST(发({ ...完整, scenario: "x".repeat(2001) }))).status).toBe(400);
    expect((await POST(发("不是 json"))).status).toBe(400);
    expect(发出的).toHaveLength(0);
  });

  it("同一 IP 一天最多几条，之后 429；换个 IP 不受影响", async () => {
    const { POST } = await import("@/app/api/lead/route");
    for (let i = 0; i < 每IP每日线索上限; i++) expect((await POST(发(完整))).status).toBe(200);
    expect((await POST(发(完整))).status).toBe(429);
    expect((await POST(发(完整, { ip: "203.0.113.8" }))).status).toBe(200);
    expect(发出的).toHaveLength(每IP每日线索上限 + 1);
  });

  it("全站一天封顶：到数之后谁来都 429", async () => {
    const { POST } = await import("@/app/api/lead/route");
    for (let i = 0; i < 每日线索总上限; i++) {
      expect((await POST(发(完整, { ip: `10.0.${Math.floor(i / 4)}.${i % 4}` }))).status).toBe(200);
    }
    expect((await POST(发(完整, { ip: "10.9.9.9" }))).status).toBe(429);
    expect(发出的).toHaveLength(每日线索总上限);
  });

  it("发失败：502，且不占额度，重试还能过", async () => {
    const { POST } = await import("@/app/api/lead/route");
    设置发送器(async () => { throw new Error("SMTP down"); });
    expect((await POST(发(完整))).status).toBe(502);
    设置发送器(async (m) => {发出的.push(m); });
    expect((await POST(发(完整))).status).toBe(200);
  });

  it("SMTP 没配：503，不发", async () => {
    const { POST } = await import("@/app/api/lead/route");
    delete process.env.SMTP_HOST;
    expect((await POST(发(完整))).status).toBe(503);
    expect(发出的).toHaveLength(0);
  });
});
