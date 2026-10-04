/**
 * 桌面端登录门填完邮箱点「继续」（lib/desktop/cloud.ts 注册开始 → 云端 /api/account/signup/start，H-055）。
 * 云端回什么、门口往哪走：409 已注册 → 输密码；要验证码 → 输码；不要 → 直接设密码。
 *
 * H-055 的事故：桌面端的新门依赖托管版的新接口，连着还没部署新版的云端就卡住（用户真机截图）。
 * 现在靠发版清单的硬闸（先部署托管版、核对版本，再推桌面端更新源，R-072）保证线上云端一定有这个接口；
 * 代码里「老云端 404」这一支还没有退路，留作【下一版】。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

beforeEach(() => {
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_CLOUD_URL = "http://cloud.test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_CLOUD_URL;
});

const 云端回 = (status: number, body: string, 记: string[] = []) =>
  vi.stubGlobal("fetch", async (url: string) => {
    记.push(String(url));
    return new Response(body, { status, headers: { "Content-Type": body.startsWith("<") ? "text/html" : "application/json" } });
  });

describe("填完邮箱点「继续」：云端说往哪走（H-055）", () => {
  it("已注册（409）→ 去输密码；要验证码 → 去输码，带着开发提示；不要验证码 → 直接设密码", async () => {
    const { 注册开始 } = await import("@/lib/desktop/cloud");
    const 记: string[] = [];
    云端回(409, JSON.stringify({ registered: true }), 记);
    expect(await 注册开始("a@x.com")).toEqual({ ok: true, data: { 去: "密码" } });
    expect(记[0]).toBe("http://cloud.test/api/account/signup/start");

    云端回(200, JSON.stringify({ verify: true, hint: "开发环境验证码：123456" }));
    expect(await 注册开始("b@x.com")).toEqual({ ok: true, data: { 去: "验证码", hint: "开发环境验证码：123456" } });

    云端回(200, JSON.stringify({ verify: false }));
    expect(await 注册开始("c@x.com")).toEqual({ ok: true, data: { 去: "设密码" } });
  });

  it("云端出别的错：原样把云端的话交给门口（不吞成「去输密码」）", async () => {
    const { 注册开始 } = await import("@/lib/desktop/cloud");
    云端回(429, JSON.stringify({ error: "操作太频繁，请 60 秒后再试" }));
    const r = await 注册开始("d@x.com");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("操作太频繁，请 60 秒后再试");
  });

  /*
    老云端没有 signup/start（next 的 404 页，HTML）：现在门口只说「服务器返回 404」，老用户连输密码那一步都到不了。
    修法：404 当作「老云端」退回旧版——直接去输密码（登录接口老云端一直有）。线上靠发版硬闸不会遇到，这一版不修
  */
  it.skip("【下一版】老云端没有这个接口（404 HTML）：退回旧版，直接去输密码，不说「服务器返回 404」", async () => {
    const { 注册开始 } = await import("@/lib/desktop/cloud");
    云端回(404, "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>");
    expect(await 注册开始("e@x.com")).toEqual({ ok: true, data: { 去: "密码" } });
  });
});
