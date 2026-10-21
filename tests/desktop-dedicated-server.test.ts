/**
 * 专属服务器（2026-10-21，客户 Even 的团队连只给他们用的云端）：src/lib/desktop/dedicated-server.ts。
 *
 * 钉四件事：
 *   1. 没设专属服务器时一切照旧（正式服 / CRM_CLOUD_URL）
 *   2. 设了以后登录、同步、策略、AI 用的令牌地址全跟着走，重启（重新加载模块）以后还在
 *   3. 地址不对、连不上、太慢、回错都说清原因、不存——**绝不悄悄退回正式服**，设置文件坏了也不退
 *   4. 只有没登录时能换
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({}),
}));

const 根 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-dedicated-"));
const 数据目录 = path.join(根, "accounts", "_未认领");
const 设置文件 = path.join(根, "dedicated-server.json");
const 令牌文件 = path.join(数据目录, ".cloud.json");
afterAll(() => fs.rmSync(根, { recursive: true, force: true }));

type 回法 = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const 关掉: (() => void)[] = [];

/** 起一个假云端，记下被问了哪些路径。回答由 回 决定；不调 res.end 就是一直不回话 */
async function 假云端(回: 回法) {
  const 问过: string[] = [];
  const 服务 = http.createServer((req, res) => {
    问过.push(`${req.method} ${req.url}`);
    回(req, res);
  });
  await new Promise<void>((ok) => 服务.listen(0, "127.0.0.1", ok));
  关掉.push(() => {
    服务.closeAllConnections();
    服务.close();
  });
  return { url: `http://127.0.0.1:${(服务.address() as { port: number }).port}`, 问过 };
}
const 回 = (status: number, body: unknown, type = "application/json"): 回法 => (_req, res) => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
/** 像我们的云端那样回：policy、登录、模型、同步 */
const 像我们的云端: 回法 = (req, res) => {
  if (req.url === "/api/account/policy") return 回(200, { register: true, inApp: true, reset: true })(req, res);
  if (req.url === "/api/account/token") return 回(200, { token: "dk_even", account: { id: "acc_even_1", name: "张三", contact: "z@even.cn" } })(req, res);
  if (req.url === "/api/gateway/v1/models") return 回(200, { data: [{ id: "m1" }] })(req, res);
  return 回(200, { ok: true })(req, res);
};

beforeEach(() => {
  fs.mkdirSync(数据目录, { recursive: true });
  fs.rmSync(设置文件, { force: true });
  fs.rmSync(令牌文件, { force: true });
  process.env.DESKTOP_LOCAL = "1";
  process.env.CRM_DATA_DIR = 数据目录;
  process.env.CRM_SERVER_FILE = 设置文件;
  delete process.env.CRM_CLOUD_URL;
  vi.resetModules();
});
afterEach(() => {
  while (关掉.length) 关掉.pop()!();
  delete process.env.DESKTOP_LOCAL;
  delete process.env.CRM_DATA_DIR;
  delete process.env.CRM_SERVER_FILE;
  delete process.env.CRM_CLOUD_URL;
  vi.restoreAllMocks();
});

describe("没设专属服务器：一切照旧", () => {
  it("没有设置文件 → 正式服", async () => {
    const { 云端地址 } = await import("@/lib/desktop/cloud");
    expect(云端地址()).toBe("https://app.ai-daedalus.com");
  });

  it("老壳不传 CRM_SERVER_FILE → 正式服；本机联调的 CRM_CLOUD_URL 照旧认", async () => {
    delete process.env.CRM_SERVER_FILE;
    process.env.CRM_CLOUD_URL = "http://127.0.0.1:9/";
    const { 云端地址 } = await import("@/lib/desktop/cloud");
    expect(云端地址()).toBe("http://127.0.0.1:9");
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    expect(await 设专属服务器("https://cn.example.com")).toEqual({ ok: false, error: expect.stringContaining("升级") });
  });

  it("登录页拿到的是「没设」，注册地址还是正式服的", async () => {
    process.env.CRM_CLOUD_URL = "http://127.0.0.1:9";
    vi.doMock("next/navigation", () => ({ redirect: () => { throw new Error("不该跳"); } }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({}) })) as { key: string; props: Record<string, unknown> };
    expect(el.props.专属服务器).toEqual({ 状态: "无" });
    expect(el.props.注册地址).toBe("http://127.0.0.1:9/signup?from=desktop");
    vi.doUnmock("next/navigation");
  });
});

describe("设了专属服务器：全跟着走", () => {
  it("填地址 → 先认一认再存；登录、模型、策略、同步都问它，令牌里记的也是它（AI 用这个地址）", async () => {
    const 正式 = await 假云端(像我们的云端);
    process.env.CRM_CLOUD_URL = 正式.url;
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    const r = await 设专属服务器(`  ${专属.url}/  `);
    expect(r).toEqual({ ok: true, 状态: { 状态: "有", url: 专属.url, name: "" } });
    expect(JSON.parse(fs.readFileSync(设置文件, "utf8")).url).toBe(专属.url);
    expect((fs.statSync(设置文件).mode & 0o777).toString(8)).toBe("600");

    const cloud = await import("@/lib/desktop/cloud");
    expect(cloud.云端地址()).toBe(专属.url);
    expect(await cloud.策略()).toEqual({ register: true, reset: true, inApp: true });
    const 登 = await cloud.登录("z@even.cn", "pw-123456");
    expect(登.ok).toBe(true);
    expect(cloud.读()?.baseUrl).toBe(专属.url);
    // AI（lib/llm-config.ts 的 环境配置）走的就是这一份：专属服务器上的网关
    expect(cloud.模型配置()?.baseUrl).toBe(`${专属.url}/api/gateway/v1`);

    const { 调云 } = await import("@/lib/sync/client");
    expect((await 调云("GET", "/api/sync/directory")).状态).toBe(200);

    expect(专属.问过).toEqual(
      expect.arrayContaining(["GET /api/account/policy", "POST /api/account/token", "GET /api/gateway/v1/models", "GET /api/sync/directory"]),
    );
    expect(正式.问过).toEqual([]);
  });

  it("重启以后（模块重新加载、壳照样传文件路径）还连着专属服务器", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    expect((await 设专属服务器(专属.url)).ok).toBe(true);
    vi.resetModules();
    const { 云端地址 } = await import("@/lib/desktop/cloud");
    expect(云端地址()).toBe(专属.url);
  });

  it("登录页显示连的是哪台，注册地址跟着换；key 是服务器地址（换了服务器整张门重来）", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    await 设专属服务器(专属.url);
    vi.doMock("next/navigation", () => ({ redirect: () => { throw new Error("不该跳"); } }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({}) })) as { key: string; props: Record<string, unknown> };
    expect(el.key).toBe(专属.url);
    expect(el.props.专属服务器).toEqual({ 状态: "有", url: 专属.url, name: "" });
    expect(el.props.注册地址).toBe(`${专属.url}/signup?from=desktop`);
    vi.doUnmock("next/navigation");
  });

  it("专属服务器码：解出地址和名字，照样先认一认", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器, 编码服务器码 } = await import("@/lib/desktop/dedicated-server");
    const 码 = 编码服务器码(专属.url, "Even 专属");
    // 从微信里复制出来常带换行、空格
    const r = await 设专属服务器(`\n${码.slice(0, 10)} ${码.slice(10)}\n`);
    expect(r).toEqual({ ok: true, 状态: { 状态: "有", url: 专属.url, name: "Even 专属" } });
    expect(专属.问过).toContain("GET /api/account/policy");
  });

  it("发码脚本（desktop/scripts/server-code.mjs）出的码，登录页解得开；认不过的地址不出码", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { execFile } = await import("node:child_process");
    const 跑 = (...参: string[]) =>
      new Promise<{ code: number; out: string }>((ok) =>
        execFile(process.execPath, ["desktop/scripts/server-code.mjs", ...参], (e, out) => ok({ code: e ? Number(e.code) : 0, out: out.trim() })),
      );
    const r = await 跑(专属.url, "Even 专属");
    expect(r.code).toBe(0);
    const { 解码服务器码 } = await import("@/lib/desktop/dedicated-server");
    expect(解码服务器码(r.out)).toEqual({ url: 专属.url, name: "Even 专属" });
    const 坏 = await 假云端(回(404, {}));
    expect((await 跑(坏.url)).code).toBe(1);
  });

  it("码只粘了一半：说码不完整，不存", async () => {
    const { 设专属服务器, 编码服务器码 } = await import("@/lib/desktop/dedicated-server");
    const 码 = 编码服务器码("https://cn.example.com", "Even");
    expect(await 设专属服务器(码.slice(0, 12))).toEqual({ ok: false, error: expect.stringContaining("不完整") });
    expect(fs.existsSync(设置文件)).toBe(false);
  });

  it("上一套云端问到的策略不算数：正式服说不收注册，换到专属服务器后登录页按「没问到」画", async () => {
    const 正式 = await 假云端(回(200, { register: false, reset: false, inApp: true }));
    process.env.CRM_CLOUD_URL = 正式.url;
    const 专属 = await 假云端((_req, res) => {
      // 认地址那一下回得正常，之后（登录页后台再问）一直不回话
      if (!专属已认) {
        专属已认 = true;
        return 回(200, { register: true, inApp: true, reset: true })(_req, res);
      }
    });
    let 专属已认 = false;
    const cloud = await import("@/lib/desktop/cloud");
    expect(await cloud.策略()).toEqual({ register: false, reset: false, inApp: true });
    expect(cloud.上次策略()).toEqual({ register: false, reset: false, inApp: true });
    const { 设专属服务器, 退出专属服务器 } = await import("@/lib/desktop/dedicated-server");
    await 设专属服务器(专属.url);
    expect(cloud.上次策略()).toEqual({ register: true, reset: true, inApp: true });
    // 退回正式服：正式服那份答案又算数了
    退出专属服务器();
    expect(cloud.上次策略()).toEqual({ register: false, reset: false, inApp: true });
  });

  it("退出专属服务器 → 回到正式服；填正式服的地址也等于退出", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器, 退出专属服务器 } = await import("@/lib/desktop/dedicated-server");
    const { 云端地址 } = await import("@/lib/desktop/cloud");
    await 设专属服务器(专属.url);
    退出专属服务器();
    expect(云端地址()).toBe("https://app.ai-daedalus.com");
    await 设专属服务器(专属.url);
    expect(await 设专属服务器("app.ai-daedalus.com")).toEqual({ ok: true, 状态: { 状态: "无" } });
    expect(fs.existsSync(设置文件)).toBe(false);
  });
});

describe("地址不对、连不上：说清原因、不存、不退回正式服", () => {
  async function 设(地址: string, 超时毫秒?: number) {
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    const r = await 设专属服务器(地址, 超时毫秒);
    expect(fs.existsSync(设置文件), "认不过的地址不该存下来").toBe(false);
    const { 云端地址 } = await import("@/lib/desktop/cloud");
    expect(云端地址()).toBe("https://app.ai-daedalus.com");
    return r;
  }

  it("空的、不像地址的、不是 http(s) 的、带账号密码的", async () => {
    expect(await 设("   ")).toEqual({ ok: false, error: expect.stringContaining("请填") });
    expect(await 设("http://")).toEqual({ ok: false, error: expect.stringContaining("不像一个服务器地址") });
    expect(await 设("ftp://cn.example.com")).toEqual({ ok: false, error: expect.stringContaining("https://") });
    expect(await 设("https://u:p@cn.example.com")).toEqual({ ok: false, error: expect.stringContaining("账号密码") });
  });

  it("连不上（端口没人听）：说连不上哪台", async () => {
    const 专属 = await 假云端(像我们的云端);
    关掉.pop()!();
    const r = await 设(专属.url);
    expect(r).toEqual({ ok: false, error: `连不上 ${new URL(专属.url).host}。检查地址有没有写错、网络通不通。` });
  });

  it("太慢（一直不回话）：等到上限就说没回应，不卡着", async () => {
    const 专属 = await 假云端(() => {});
    const 起 = Date.now();
    const r = await 设(专属.url, 300);
    expect(Date.now() - 起).toBeLessThan(3000);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("秒没回应") });
  });

  for (const [情况, 回法, 应说] of [
    ["404（不是我们的云端）", 回(404, { error: "not found" }), "没有 Daedalus CRM 的账号服务"],
    ["502（正在重启）", 回(502, "<html>Bad Gateway</html>", "text/html"), "回了 502"],
    ["503", 回(503, { error: "x" }), "回了 503"],
    ["500", 回(500, { error: "x" }), "回了 500"],
    ["200 回 HTML（公司网 / 酒店 Wi-Fi 的登录页）", 回(200, "<html>请先登录</html>", "text/html"), "回的不是 Daedalus CRM"],
    ["200 回空", 回(200, ""), "回的不是 Daedalus CRM"],
    ["200 回数组", 回(200, [1, 2]), "回的不是 Daedalus CRM"],
    ["200 回的 JSON 没有 register", 回(200, { ok: true }), "回的不是 Daedalus CRM"],
  ] as const) {
    it(`${情况}：说清原因`, async () => {
      const 专属 = await 假云端(回法);
      expect(await 设(专属.url)).toEqual({ ok: false, error: expect.stringContaining(应说) });
    });
  }

  it("设好以后专属服务器挂了：登录说连不上它（带它的地址），不去问正式服", async () => {
    const 正式 = await 假云端(像我们的云端);
    process.env.CRM_CLOUD_URL = 正式.url;
    const 专属 = await 假云端(像我们的云端);
    const { 设专属服务器 } = await import("@/lib/desktop/dedicated-server");
    await 设专属服务器(专属.url);
    关掉.pop()!(); // 专属那台关了
    const cloud = await import("@/lib/desktop/cloud");
    const r = await cloud.登录("z@even.cn", "pw-123456");
    expect(r).toEqual({ ok: false, error: expect.stringContaining(new URL(专属.url).host) });
    expect(await cloud.策略()).toEqual({ register: true, reset: true, inApp: true });
    expect(正式.问过).toEqual([]);
  });

  it("设置文件坏了（被截断 / 手改坏）：不退回正式服，每个请求都失败，登录页拿到「坏了」", async () => {
    const 正式 = await 假云端(像我们的云端);
    process.env.CRM_CLOUD_URL = 正式.url;
    fs.writeFileSync(设置文件, '{"url": "https://cn.exa');
    const cloud = await import("@/lib/desktop/cloud");
    expect(cloud.云端地址()).toBe("https://dedicated-server-unreadable.invalid");
    expect((await cloud.登录("z@even.cn", "pw-123456")).ok).toBe(false);
    expect(正式.问过).toEqual([]);
    vi.doMock("next/navigation", () => ({ redirect: () => { throw new Error("不该跳"); } }));
    const { default: LoginPage } = await import("@/app/login/page");
    const el = (await LoginPage({ searchParams: Promise.resolve({}) })) as { props: Record<string, unknown> };
    expect(el.props.专属服务器).toEqual({ 状态: "坏了" });
    vi.doUnmock("next/navigation");
    // 坏了也能退回正式服
    const { 退出专属服务器 } = await import("@/lib/desktop/dedicated-server");
    退出专属服务器();
    expect(cloud.云端地址()).toBe(正式.url);
  });
});

describe("只有没登录时能换", () => {
  it("登录着：设、退都拒，文件不动", async () => {
    const 专属 = await 假云端(像我们的云端);
    fs.writeFileSync(令牌文件, JSON.stringify({ baseUrl: "https://app.ai-daedalus.com", token: "dk_x", name: "某人", contact: "a@b.c", models: [] }));
    const { 桌面端设专属服务器, 桌面端退出专属服务器 } = await import("@/app/login/actions");
    expect(await 桌面端设专属服务器(专属.url)).toEqual({ ok: false, error: "先退出登录，再换服务器" });
    expect(fs.existsSync(设置文件)).toBe(false);
    expect(专属.问过).toEqual([]);
    fs.writeFileSync(设置文件, JSON.stringify({ url: 专属.url, name: "" }));
    expect(await 桌面端退出专属服务器()).toEqual({ ok: false, error: "先退出登录，再换服务器" });
    expect(fs.existsSync(设置文件)).toBe(true);
  });

  it("没登录：能设、能退", async () => {
    const 专属 = await 假云端(像我们的云端);
    const { 桌面端设专属服务器, 桌面端退出专属服务器 } = await import("@/app/login/actions");
    expect((await 桌面端设专属服务器(专属.url)).ok).toBe(true);
    expect(fs.existsSync(设置文件)).toBe(true);
    expect(await 桌面端退出专属服务器()).toEqual({ ok: true, 状态: { 状态: "无" } });
    expect(fs.existsSync(设置文件)).toBe(false);
  });

  it("不是桌面端本地模式：拒", async () => {
    delete process.env.DESKTOP_LOCAL;
    const { 桌面端设专属服务器 } = await import("@/app/login/actions");
    expect((await 桌面端设专属服务器("https://cn.example.com")).ok).toBe(false);
  });
});

describe("壳", () => {
  it("每次起本地服务都把数据根里的设置文件路径传过去；自动更新的源不看它", () => {
    const main = fs.readFileSync(path.resolve("desktop/main.js"), "utf8");
    expect(main).toMatch(/CRM_SERVER_FILE: 云端\.专属服务器文件\(数据根\)/);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const 云端 = require(path.resolve("desktop/cloud.js"));
    expect(云端.专属服务器文件("/x/DaedalusCRM")).toBe(path.join("/x/DaedalusCRM", "dedicated-server.json"));
    const updater = fs.readFileSync(path.resolve("desktop/updater.js"), "utf8");
    expect(updater).not.toMatch(/dedicated-server|CRM_SERVER_FILE|CRM_CLOUD_URL/);
  });
});
