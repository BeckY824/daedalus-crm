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
import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    // 刻意用一眼看得出是假的字符串：十六进制那种写法会被密钥扫描当成真 API Key
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    const { GET } = await import("@/app/api/desktop/session/route");
    // 依次是：空、太短、等长但差一个字符、更长、更短——定长比较的每种错法
    for (const t of ["", "x", "desktop-token-for-testt", "desktop-token-for-testsX", "desktop-token-for-test"]) {
      const res = await GET(new Request(`${URL_}?t=${t}`));
      expect(res.status, `令牌 ${JSON.stringify(t)} 不该放行`).toBe(403);
    }
  });
});

/**
 * 本地模式下 /login 是**云端账号**的门（2026-09-17 起桌面端只有这一套身份）。
 *
 * 在那之前 /login 认的是业务库里那个管理员自己的随机密码——用户从没见过它，
 * 于是「退出登录」之后就被锁在自己机器外面。现在：手上有令牌的人不停在这一页
 * （跳回自动登录），没有的人看到的是云端账号的表单，注册、找回密码都在。
 */
describe("本地模式下 /login 是云端账号的门", () => {
  const 数据目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-login-"));
  const 令牌文件 = path.join(数据目录, ".cloud.json");
  afterAll(() => fs.rmSync(数据目录, { recursive: true, force: true }));
  beforeEach(() => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    process.env.CRM_DATA_DIR = 数据目录;
    // 策略() 会去问云端；这里不联网，让它立刻失败——登录页只留登录那一条
    process.env.CRM_CLOUD_URL = "http://127.0.0.1:9";
    fs.rmSync(令牌文件, { force: true });
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.CRM_DATA_DIR;
    delete process.env.CRM_CLOUD_URL;
    vi.doUnmock("next/navigation");
  });

  it("手上有令牌：直接跳回自动登录那条路，不停在这一页", async () => {
    fs.writeFileSync(令牌文件, JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "dk_x", name: "某人", contact: "a@b.c", models: [] }));
    const 跳了: string[] = [];
    vi.doMock("next/navigation", () => ({
      redirect: (u: string) => {
        跳了.push(u);
        throw new Error("NEXT_REDIRECT");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
    expect(跳了).toEqual(["/api/desktop/session?t=desktop-token-for-tests"]);
  });

  it("没有令牌：画的是云端账号那张表单", async () => {
    vi.doMock("next/navigation", () => ({
      redirect: () => {
        throw new Error("没令牌不该跳");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({}) })) as { props: Record<string, unknown> };
    expect(el.props.桌面端).toBe(true);
    expect(el.props.注册地址).toContain("/signup?from=desktop");
  });

  it("被吊销送回来的（?reason=revoked）：有令牌也不跳，先把原因说清", async () => {
    fs.writeFileSync(令牌文件, JSON.stringify({ baseUrl: "http://127.0.0.1:9", token: "dk_x", name: "", contact: "a@b.c", models: [] }));
    vi.doMock("next/navigation", () => ({
      redirect: () => {
        throw new Error("带原因来的不该跳");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({ reason: "revoked" }) })) as { props: Record<string, unknown> };
    expect(String(el.props.提示)).toContain("改过密码");
    expect(String(el.props.提示)).toContain("已登录的机器");
  });

  it("自动登录路由：没有令牌文件就先清 cookie 再回登录页，不签会话", async () => {
    /**
     * 直接跳 /login 不行：业务会话 cookie 可能还活着（7 天），proxy.ts 会把 /login 弹回
     * /dashboard，人就带着一个失效的云端账号进了应用。经 logout 走，原因原样带过去。
     */
    const { GET } = await import("@/app/api/desktop/session/route");
    const res = await GET(new Request(`${URL_}?t=desktop-token-for-tests`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/api/auth/logout");
    const 带原因 = await GET(new Request(`${URL_}?t=desktop-token-for-tests&reason=revoked`));
    expect(带原因.headers.get("location")).toBe("/api/auth/logout?reason=revoked");
  });

  it("应用壳：本地模式下令牌没了就不给进，哪怕业务会话还活着", async () => {
    const layout = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain('if (本地模式() && !读云端凭据()) redirect("/api/auth/logout?reason=revoked");');
    const logout = fs.readFileSync(path.resolve(__dirname, "../src/app/api/auth/logout/route.ts"), "utf8");
    expect(logout).toContain('url.searchParams.set("reason", reason)');
  });

  it("没开本地模式的部署照常画登录页，一步都不跳", async () => {
    delete process.env.DESKTOP_LOCAL;
    vi.doMock("next/navigation", () => ({
      redirect: () => {
        throw new Error("自部署和托管版都不该跳");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({}) })) as { props: Record<string, unknown> };
    expect(el.props.桌面端 ?? false).toBe(false);
  });

  it("壳里「退出登录」一直在：本地模式下它退的是云端账号", async () => {
    const shell = fs.readFileSync(path.resolve(__dirname, "../src/components/AppShell.tsx"), "utf8");
    expect(shell).toContain('label: "退出登录"');
    expect(shell).not.toMatch(/本机\s*\?\s*\[\]/);
    const logout = fs.readFileSync(path.resolve(__dirname, "../src/app/api/auth/logout/route.ts"), "utf8");
    const post = logout.slice(logout.indexOf("export async function POST"), logout.indexOf("export async function GET"));
    expect(post).toContain("退出云端()");
  });
});

describe("回到上一页：next 只认站内的应用路径", () => {
  it("正常的应用路径原样用，query 一起带", async () => {
    const { 选落点 } = await import("@/app/api/desktop/session/route");
    expect(选落点("/customers/abc")).toBe("/customers/abc");
    expect(选落点("/customers?status=待跟进")).toBe("/customers?status=待跟进");
  });
  it("门口那些页、别的站、协议相对地址、空的：一律回 /dashboard", async () => {
    const { 选落点 } = await import("@/app/api/desktop/session/route");
    for (const v of [null, "", "/", "/login", "/login?x=1", "/api/auth/logout", "/admin", "//evil.com/x", "https://evil.com/x", "customers/abc"]) {
      expect(选落点(v), String(v)).toBe("/dashboard");
    }
  });
});
