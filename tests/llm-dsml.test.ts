/**
 * DeepSeek 的工具调用被中转站当正文吐回来时，认回成 tool_calls（lib/llm-dsml.ts）。
 *
 * 2026-09-28 桌面端：决策那几步日志全是「没调工具」，其实调了——DSML 标记原样躺在 content 里。
 * 工具没跑、建议卡没出，回答里却说「你在卡片上确认一下」。第一组用的就是屏幕上那串原文。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { 解析DSML, 有DSML } from "@/lib/llm-dsml";

const 屏幕上那串 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="find_person">
<｜｜DSML｜｜ parameter name="name" string="true">李文龙</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const 标准写法 = `好的，我先找一下这位客户。
<｜DSML｜function_calls>
<｜DSML｜invoke name="find_person">
<｜DSML｜parameter name="name" string="true">李文龙</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="propose_plan">
<｜DSML｜parameter name="id" string="true">c_123</｜DSML｜parameter>
<｜DSML｜parameter name="subject" string="true">交付</｜DSML｜parameter>
<｜DSML｜parameter name="plannedAt" string="true">2026-09-29 10:00</｜DSML｜parameter>
<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>
<｜DSML｜parameter name="flags" string="false">{"urgent": true}</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜function_calls>`;

describe("解析DSML", () => {
  it("中转站吐回来的那串（竖线叠成两个、function_calls 只剩 calls）认得出", () => {
    expect(有DSML(屏幕上那串)).toBe(true);
    const r = 解析DSML(屏幕上那串, ["find_person", "propose_plan"]);
    expect(r.调用.map((c) => c.function.name)).toEqual(["find_person"]);
    expect(JSON.parse(r.调用[0].function.arguments)).toEqual({ name: "李文龙" });
    expect(r.调用[0].type).toBe("function");
    expect(r.余下).toBe("");
  });

  it("标准写法：多个调用按顺序、string=false 的按 JSON 解、前面的人话留下", () => {
    const r = 解析DSML(标准写法, ["find_person", "propose_plan"]);
    expect(r.调用.map((c) => c.function.name)).toEqual(["find_person", "propose_plan"]);
    expect(JSON.parse(r.调用[1].function.arguments)).toEqual({
      id: "c_123", subject: "交付", plannedAt: "2026-09-29 10:00", limit: 5, flags: { urgent: true },
    });
    expect(new Set(r.调用.map((c) => c.id)).size, "同一段里的调用 id 不能撞").toBe(2);
    expect(r.余下).toBe("好的，我先找一下这位客户。");
  });

  it("不在名单里的工具丢掉；string=true 的数字照样是字符串（手机号不能被解成数字）", () => {
    const t = `<｜DSML｜invoke name="rm_rf"></｜DSML｜invoke><｜DSML｜invoke name="find_person"><｜DSML｜parameter name="phone" string="true">13800138000</｜DSML｜parameter></｜DSML｜invoke>`;
    const r = 解析DSML(t, ["find_person"]);
    expect(r.调用.map((c) => c.function.name)).toEqual(["find_person"]);
    expect(JSON.parse(r.调用[0].function.arguments)).toEqual({ phone: "13800138000" });
  });

  it("半截（没有收尾标签）不认：参数可能缺一半，宁可当没调", () => {
    const r = 解析DSML(`<｜DSML｜function_calls><｜DSML｜invoke name="find_person"><｜DSML｜parameter name="name" string="true">李`, ["find_person"]);
    expect(r.调用).toEqual([]);
  });

  it("没有 DSML 的正常回答原样不动", () => {
    expect(有DSML("李文龙明天 10 点交付，已排好。")).toBe(false);
    expect(解析DSML("李文龙明天 10 点交付。", ["find_person"])).toEqual({ 调用: [], 余下: "李文龙明天 10 点交付。" });
  });
});

describe("chatTools：content 里是 DSML、tool_calls 为空时认回来", () => {
  vi.mock("@/lib/settings", () => ({
    getSetting: async () => null, setSetting: async () => {}, encryptSecret: (s: string) => s, decryptSecret: (s: string) => s, maskSecret: (s: string) => s,
  }));
  const 原 = { ...process.env };
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
  });
  afterEach(() => {
    process.env = { ...原 };
    vi.unstubAllGlobals();
  });
  const 工具表 = ["find_person", "propose_plan"].map((name) => ({ type: "function" as const, function: { name, description: "", parameters: {} } }));
  const 回 = (message: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));

  it("中转站把调用塞在 content 里：当成调了，不是「没调工具」", async () => {
    回({ content: 屏幕上那串, tool_calls: null });
    const { chatTools } = await import("@/lib/llm");
    const r = await chatTools([{ role: "user", content: "我没有看到卡片" }], 工具表);
    expect(r.toolCalls.map((c) => c.function.name)).toEqual(["find_person"]);
    expect(r.text).toBe("");
  });

  it("混合正文和原生工具调用：保留人话和原生ID，不重复执行DSML调用", async () => {
    回({ content: "我先找一下。\n" + 屏幕上那串 + "\n请稍等。", tool_calls: [{ id: "native1", type: "function", function: { name: "find_person", arguments: '{"name":"李文龙"}' } }] });
    const { chatTools } = await import("@/lib/llm");
    const r = await chatTools([{ role: "user", content: "查李文龙" }], 工具表);
    expect(r.toolCalls.map(c => c.id)).toEqual(["native1"]);
    expect(r.text).toContain("我先找一下。");
    expect(r.text).toContain("请稍等。");
    expect(r.text).not.toMatch(/DSML|李文龙/);
  });
  it("半截DSML的参数正文也不进入打算文本", async () => {
    回({ content: '先查。<｜DSML｜invoke name="find_person"><｜DSML｜parameter name="name" string="true">私密参数', tool_calls: [] });
    const { chatTools } = await import("@/lib/llm");
    const r = await chatTools([{ role: "user", content: "查" }], 工具表);
    expect(r.toolCalls).toEqual([]);
    expect(r.text).toBe("先查。");
  });

  it("正常的 tool_calls 不受影响", async () => {
    回({ content: "", tool_calls: [{ id: "x1", type: "function", function: { name: "propose_plan", arguments: "{}" } }] });
    const { chatTools } = await import("@/lib/llm");
    const r = await chatTools([{ role: "user", content: "排个计划" }], 工具表);
    expect(r.toolCalls.map((c) => c.id)).toEqual(["x1"]);
  });
});
