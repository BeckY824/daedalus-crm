/**
 * 过程条那句人话。钉的是 2026-09-18 那张截图：查了 list_channels、答对了，
 * 过程条却写「没有读取任何记录」——原来那段 if 只认五个工具。
 */
import { describe, it, expect } from "vitest";
import { summarizeSteps } from "@/lib/agent/step-summary";

const 步 = (label: string, i = 0) => ({ id: `tool-${i}`, label });

describe("summarizeSteps", () => {
  it("查了渠道清单就说查了渠道清单，不说「没有读取任何记录」", () => {
    expect(summarizeSteps([步("list_channels({})")], "客户")).toBe("查了渠道清单");
  });
  it("几个工具串起来", () => {
    const s = summarizeSteps([步("search_customers({query:张三})", 0), 步("get_customer({id:x})", 1), 步("query_metric({..})", 2)], "学员");
    expect(s).toBe("搜了 1 次，读了 1 位学员的记录，查了 1 个数");
  });
  it("几张建议卡合成一句", () => {
    expect(summarizeSteps([步("propose_followup({})", 0), 步("propose_plan({})", 1)], "客户")).toBe("拟了一张建议卡");
  });
  it("一个工具都没调：如实说没查数据", () => {
    expect(summarizeSteps([{ id: "answer", label: "组织回答" }], "客户")).toBe("没查数据");
  });
  it("没登记的工具也不至于闭嘴", () => {
    expect(summarizeSteps([步("some_new_tool({})")], "客户")).toBe("调了 some_new_tool");
  });
});
