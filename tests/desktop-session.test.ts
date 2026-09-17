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
 * 本地模式下**不该有人停在登录页**。
 *
 * 那一页在本机是个死胡同：密码是建库时生成的随机串（server-entry.js 写进
 * `.init-password`），用户从没见过；而「忘记密码」在本机永远画不出来——
 * 那个链接由 `能找回密码()` 决定，它要控制面 + SMTP，本机两个都没有。
 * 于是任何一条落到 /login 的路都是把人锁在自己机器外面。真的发生过：
 * 用户在应用里点了左下角的「退出登录」，然后对着一个填不进去的框。
 *
 * 两头一起堵：源头撤掉那个按钮，落点跳回自动登录。
 */
describe("本地模式下不该有人停在登录页", () => {
  it("/login 在本地模式直接跳回自动登录那条路", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
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
    vi.doUnmock("next/navigation");
    vi.resetModules();
  });

  it("带 fallback 时才画表单——否则自动登录失败就成了跳不出去的圈", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    vi.doMock("next/navigation", () => ({
      redirect: () => {
        throw new Error("不该跳");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = await LoginPage({ searchParams: Promise.resolve({ fallback: "1" }) });
    // 画出来的表单要知道自己在本机，它据此说清「密码在应用菜单里」
    expect((el as { props: { 本机: boolean } }).props.本机).toBe(true);
    vi.doUnmock("next/navigation");
    vi.resetModules();
  });

  it("没开本地模式的部署照常画登录页，一步都不跳", async () => {
    vi.doMock("next/navigation", () => ({
      redirect: () => {
        throw new Error("自部署和托管版都不该跳");
      },
    }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = await LoginPage({ searchParams: Promise.resolve({}) });
    expect((el as { props: { 本机: boolean } }).props.本机).toBe(false);
    vi.doUnmock("next/navigation");
    vi.resetModules();
  });

  it("库里没有在职管理员时回登录页，不是 500——500 等于把人锁在应用外面", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/api/desktop/session/route.ts"), "utf8");
    const i = src.indexOf("if (!admin)");
    expect(i, "找不到没有管理员那一支").toBeGreaterThan(0);
    const 段 = src.slice(i, i + 200);
    expect(段).toContain("/login?fallback=1");
    expect(段).not.toContain("500");
  });

  it("本机模式下壳里不摆「退出登录」", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const shell = fs.readFileSync(path.resolve(__dirname, "../src/components/AppShell.tsx"), "utf8");
    const i = shell.indexOf("const userMenu");
    expect(i).toBeGreaterThan(0);
    const 段 = shell.slice(i, shell.indexOf("};", i));
    // 那一条要被本机模式挡住，而不是永远摆着
    expect(段).toMatch(/本机\s*\n?\s*\?\s*\[\]/);
    expect(段).toContain("退出登录");

    // 壳自己判断不了「是不是本地模式」（连服务器时 UA 也是 Electron），得由服务端给
    const layout = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain('process.env.DESKTOP_LOCAL === "1"');
    expect(layout).toMatch(/本机=\{本机\}/);
  });
});
