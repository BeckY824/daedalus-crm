/**
 * 背调的「卡住重发一次」和按字符截（lib/research/retry.ts，10-16 下午 ABC 试跑：一次模型调用干等 180 秒、整次报废；结论硬切半句）。
 */
import { describe, it, expect, vi } from "vitest";
import { 背调超时, 重发一次, 该重发, 截, 全句 } from "@/lib/research/retry";

const 超时错 = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

describe("重发一次", () => {
  it("超时、5xx 重发一次；第二趟成了就用第二趟的", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    expect(await 重发一次(async () => (++n === 1 ? Promise.reject(超时错()) : "好"), 1000)).toBe("好");
    n = 0;
    expect(await 重发一次(async () => (++n === 1 ? Promise.reject(Object.assign(new Error("x"), { status: 502 })) : "好"), 1000)).toBe("好");
  });

  it("只重发一次：连着两次都卡就抛", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const 做 = vi.fn(async () => Promise.reject(超时错()));
    await expect(重发一次(做, 1000)).rejects.toThrow("timeout");
    expect(做).toHaveBeenCalledTimes(2);
  });

  it("4xx、调用方自己停的不重发", async () => {
    const 做 = vi.fn(async () => Promise.reject(Object.assign(new Error("bad"), { status: 400 })));
    await expect(重发一次(做, 1000)).rejects.toThrow("bad");
    expect(做).toHaveBeenCalledTimes(1);
    const 停 = new AbortController();
    停.abort();
    expect(该重发(超时错(), 停.signal)).toBe(false);
  });

  it("每一趟有自己的超时：卡住的那趟到点就断，重发的那趟重新计时", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const r = await 重发一次(
      (signal) =>
        new Promise<string>((ok, bad) => {
          if (++n === 2) return ok("第二趟");
          signal.addEventListener("abort", () => bad(signal.reason));
        }),
      50,
    );
    expect(r).toBe("第二趟");
  });

  it("服务器那一层先到点：网关等上游 < 桌面端每一趟；搜索接口 > 服务器两趟搜索", () => {
    expect(背调超时.上游模型).toBeLessThan(背调超时.模型每次);
    expect(背调超时.搜索接口).toBeGreaterThan(背调超时.搜索每次 * 2);
  });
});

describe("截", () => {
  it("按字符截、截了带省略号；不切坏表情；没超就原样", () => {
    expect(截("全球业务覆盖17个国家", 6)).toBe("全球业务覆…");
    expect(Array.from(截("😀".repeat(10), 5))).toHaveLength(5);
    expect(截("😀".repeat(10), 5)).not.toContain("�");
    expect(截("  规模较大  ", 10)).toBe("规模较大");
    expect(截(undefined, 10)).toBe("");
  });
});

describe("取回答（10-17：gpt-5.5 思考把 max_tokens 用光，正文是空的，原来被当成 {} 收下，6 步「完成」却没分）", () => {
  it("被截断、要 JSON 却是空的都抛 截断了；带工具调用的不算", async () => {
    const { 取回答, 截断了 } = await import("@/lib/research/retry");
    expect(() => 取回答({ choices: [{ message: { content: "" }, finish_reason: "length" }] }, true)).toThrow(截断了);
    expect(() => 取回答({ choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }] }, false)).toThrow(截断了);
    expect(() => 取回答({ choices: [{ message: { content: "  " }, finish_reason: "stop" }] }, true)).toThrow("正文是空的");
    expect(取回答({ choices: [{ message: { content: "", tool_calls: [{ id: "1" }] }, finish_reason: "length" }] }, true).tool_calls).toHaveLength(1);
    expect(取回答({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }, false).content).toBe("");
    expect(取回答({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }, true).content).toBe("{}");
  });
});

describe("全句（给人看的结论，10-18：不带「…」）", () => {
  it("没超原样；超了在上限内最后一个整句收住，没有句号就在逗号前收，都没有才硬断；永远不加省略号", () => {
    expect(全句("规模中等。", 10)).toBe("规模中等。");
    expect(全句("第一句很长很长。第二句也很长很长很长。第三句", 20)).toBe("第一句很长很长。第二句也很长很长很长。");
    expect(全句("Founded in 1998. Imports LED panels from Ningbo and Xiamen", 30)).toBe("Founded in 1998.");
    expect(全句("汉堡的照明进口分销商，规模中等，主营户外灯具和工程照明", 16)).toBe("汉堡的照明进口分销商，规模中等");
    expect(全句("一二三四五六七八九十一二三四五", 6)).toBe("一二三四五六");
    expect(全句("模型自己写的省略号…", 50)).toBe("模型自己写的省略号");
    expect(全句("three dots...", 50)).toBe("three dots");
    expect(全句(undefined, 10)).toBe("");
    for (const n of [5, 17, 40, 120]) expect(全句("这家公司在汉堡，做照明进口……还有别的；也做工程。".repeat(5), n)).not.toMatch(/…$|\.\.\.$/);
  });
});
