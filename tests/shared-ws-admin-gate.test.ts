/**
 * 共享工作区不给管理员动作，以及「测试连接」不会把服务端的 Key 送到任意地址。
 *
 * 这两条是同一件事的两面。网页版只有一个共享工作区，一套固定账号密码发给要试用的团队
 * （2026-09-16 起；在那之前是免登录的共享工作区，风险同源）。那个用户的角色是 ADMIN——
 * 它得能展示管理员看到的东西——而密码在多个团队手里，于是「管理员」在那里
 * 等于「拿到过密码的任何人」。设置页里最贵的一个按钮是 AI 接入那栏的「测试连接」：
 * 它会拿一把 Key 往调用方自己填的地址发一次请求。
 *
 * 所以两道都要有：共享工作区整个不给过 requireAdmin；就算过了，环境里那把 Key
 * 也只肯发给环境里配的那个地址。少一道都够把托管版的 LLM Key 送出去。
 */
import { describe, it, expect, afterEach } from "vitest";

const 原始 = { ...process.env };
afterEach(() => {
  process.env.LLM_API_KEY = 原始.LLM_API_KEY;
  process.env.LLM_BASE_URL = 原始.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
});

describe("「测试连接」不把环境里的 Key 送到别处", () => {
  it("地址和环境里配的不一样时，当作没有 Key", async () => {
    const { resolveLlmConfigForTest } = await import("@/lib/llm");
    process.env.LLM_API_KEY = "平台共用的那把";
    process.env.LLM_BASE_URL = "https://relay.example.com/v1";

    const 别处 = await resolveLlmConfigForTest({ baseUrl: "https://evil.example.net/v1", model: "x" });
    expect(别处, "环境里那把 Key 不该发到调用方自己填的地址").toBeNull();

    const 本处 = await resolveLlmConfigForTest({ baseUrl: "https://relay.example.com/v1", model: "x" });
    expect(本处?.apiKey).toBe("平台共用的那把");
  });

  it("末尾的斜杠不算另一个地址", async () => {
    const { resolveLlmConfigForTest } = await import("@/lib/llm");
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://relay.example.com/v1";
    expect((await resolveLlmConfigForTest({ baseUrl: "https://relay.example.com/v1/", model: "x" }))?.apiKey).toBe("k");
  });

  it("自己填了 Key 的，想发哪儿发哪儿——那是他自己的 Key", async () => {
    const { resolveLlmConfigForTest } = await import("@/lib/llm");
    process.env.LLM_API_KEY = "平台共用的那把";
    process.env.LLM_BASE_URL = "https://relay.example.com/v1";
    const cfg = await resolveLlmConfigForTest({ baseUrl: "https://my-own.example.net/v1", model: "x", apiKey: "我自己的" });
    expect(cfg?.apiKey).toBe("我自己的");
  });
});

describe("共享工作区的管理员动作", () => {
  it("settings 的 requireAdmin 里有共享工作区这一道", async () => {
    /**
     * 这一条只看源码，不跑动作：requireAdmin 要 Next 的请求上下文和一个真工作区，
     * 搭起来的成本远大于它能证明的东西。而真正会坏的是「哪天有人把这几行删了」，
     * 那用源码就看得出来。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/actions.ts"), "utf8");
    const 段 = src.slice(src.indexOf("async function requireAdmin()"), src.indexOf("async function requireAdmin()") + 400);
    expect(段).toContain("当前是共享区");
    expect(段).toContain("FORBIDDEN");
  });
});

describe("两条容易被下一个人改坏的约定", () => {
  it("共享工作区里界面上也不摆管理员那几栏", async () => {
    /**
     * 服务端已经不给共享工作区过 requireAdmin 了，但界面还照旧画「AI 接入」那一栏的话：
     * 一是点了只会报错，二是那一栏会把平台 Key 的尾 4 位显示出来。
     * 所以 settings/page.tsx 要在共享工作区里把 isAdmin 直接按 false 传。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/page.tsx"), "utf8");
    expect(src).toContain("当前是共享区");
    expect(src).toMatch(/isAdmin=\{[^}]*!\s*共享区\s*\}/);
  });

  it("共享工作区里不摆「已登录的机器」——那一栏里会是别人的机器", async () => {
    /**
     * 设备令牌挂在控制面账号上，而共享工作区那一套账号密码发给了多个团队：
     * A 团队打开设置页会看到 B 团队的机器名，「退出」还能把 B 正在用的那台踢下线。
     * 所以 我的控制面账号 在共享区直接回 null，界面上那一栏整个不出现（机器 && …）。
     * 自部署版同理：那边桌面端不连控制面，压根没有设备令牌。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const 动作 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/actions.ts"), "utf8");
    const i = 动作.indexOf("async function 我的控制面账号");
    expect(i, "找不到 我的控制面账号").toBeGreaterThan(0);
    const 段 = 动作.slice(i, 动作.indexOf("\n}", i));
    expect(段).toContain("当前是共享区");
    expect(段).toContain("托管版()");
    expect(段).toContain("return null");
    // 列表和「退出」两条路都要过这道闸，只挡住一条等于没挡
    for (const 名 of ["我的机器", "退出这台机器"]) {
      const j = 动作.indexOf(`export async function ${名}`);
      expect(j, `找不到 ${名}`).toBeGreaterThan(0);
      expect(动作.slice(j, 动作.indexOf("\n}", j)), `${名} 没过 我的控制面账号`).toContain("我的控制面账号(me.id)");
    }

    const 界面 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/SettingsView.tsx"), "utf8");
    expect(界面).toContain("已登录的机器");
    // null 就整栏不画：共享区和自部署版拿到的都是 null
    expect(界面).toMatch(/\{机器 && \(/);
  });

  it("改密码那一屏要写清「所有机器都要重新登录」", async () => {
    /**
     * 改密码会把这个账号的桌面端全部踢下线（members.ts 的 改密码）。
     * /forgot 和桌面端那块面板都写了这句，设置页这一屏最早漏了——
     * 而它正是自己改密码最常走的那条路。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const 界面 = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/SettingsView.tsx"), "utf8");
    const i = 界面.indexOf('key: "password"');
    expect(i).toBeGreaterThan(0);
    const 段 = 界面.slice(i, i + 2000);
    expect(段).toMatch(/所有地方都要重新登录|所有.{0,4}机器.{0,8}重新登录/);
    expect(段, "还要指一条只退一台的路，否则人只能拿改密码当锤子").toContain("已登录的机器");
  });

  it("AI 配置的操作日志不带 detail", async () => {
    /**
     * 操作日志那一栏**不在 isAdmin 判断之内**——普通销售也看得到。
     * 而 recordAudit 的 detail 是个自由字段：哪天有人照着「业务配置」那条
     * （它传了完整的 before/after）给 AI 配置也加一个 detail，
     * 明文 Key 就会落进一张全员可读的表里。这条把现状钉住。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/settings/actions.ts"), "utf8");
    for (const 名 of ["saveLlmSettings", "clearLlmSettings"]) {
      const i = src.indexOf(`export async function ${名}`);
      expect(i, `找不到 ${名}`).toBeGreaterThan(0);
      const 段 = src.slice(i, src.indexOf("\n}", i));
      expect(段.includes("recordAudit"), `${名} 应当记一条日志`).toBe(true);
      expect(段.includes("detail:"), `${名} 的日志不能带 detail——那张表全员可读`).toBe(false);
    }
  });
});
