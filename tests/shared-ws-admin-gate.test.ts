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
