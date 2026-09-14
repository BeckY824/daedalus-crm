/**
 * 桌面端本地模式的自动登录路由。
 *
 * 这个路由不要密码就能签发一张管理员会话票据，所以它的守卫是安全边界，
 * 必须钉死：托管版和自部署版的构建产物里也有这个文件，只是没开 DESKTOP_LOCAL——
 * 哪天有人手滑把开关打开、或者守卫被改坏，那就是一个公开的免密登录入口。
 *
 * 放行那条路（令牌对 → 建会话 → 跳 /dashboard）要真业务库才跑得起来，
 * 由桌面端的实机验证覆盖：装出来的 app 首次启动确实自动登录成功。
 * 这里只钉「什么情况下不给进」。
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// 路由引了 auth.ts，它在模块顶层就 import next/headers，vitest 里直接 import 会炸
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const URL_ = "http://127.0.0.1:1234/api/desktop/session";

afterEach(() => {
  delete process.env.DESKTOP_LOCAL;
  delete process.env.DESKTOP_TOKEN;
});

describe("没开本地模式时这个路由不存在", () => {
  it("两个开关都没有 → 404", async () => {
    const { GET } = await import("@/app/api/desktop/session/route");
    expect((await GET(new Request(`${URL_}?t=x`))).status).toBe(404);
  });

  it("只有令牌、没开开关 → 404", async () => {
    process.env.DESKTOP_TOKEN = "abc";
    const { GET } = await import("@/app/api/desktop/session/route");
    expect((await GET(new Request(`${URL_}?t=abc`))).status).toBe(404);
  });

  it("开了开关但没有令牌 → 404，不能退化成谁来都放行", async () => {
    process.env.DESKTOP_LOCAL = "1";
    const { GET } = await import("@/app/api/desktop/session/route");
    expect((await GET(new Request(`${URL_}?t=`))).status).toBe(404);
  });
});

describe("开了本地模式，令牌必须对", () => {
  it("不带令牌、令牌错、长度不同都拒，且不会因为长度不同而抛错", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "0123456789abcdef";
    const { GET } = await import("@/app/api/desktop/session/route");
    for (const t of ["", "x", "0123456789abcdee", "0123456789abcdef0", "0123456789abcde"]) {
      const res = await GET(new Request(`${URL_}?t=${t}`));
      expect(res.status, `令牌 ${JSON.stringify(t)} 不该放行`).toBe(403);
    }
  });
});
