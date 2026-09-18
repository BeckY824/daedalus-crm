/**
 * 意图直连：固定的问题不问模型。
 *
 * 用户那句话是对的——业务逻辑和字段是固定的，不该每次让模型重新推理一遍。
 * 这张表把「这类问题 → 这条查询」钉死：命中就直接跑，省掉一次决策往返，
 * 同一句话永远走同一条路。
 *
 * **这组用例的重点不是「命中了多少」，是「不该命中的一条都没命中」。**
 * 漏了只是慢一点（落回 agent 循环），错了是答非所问。
 */
import { describe, it, expect } from "vitest";
import { 认意图, 意图表 } from "@/lib/agent/intents";
import { 扩同义词 } from "@/lib/agent/synonyms";

describe("该命中的", () => {
  const 样本: [string, string, string][] = [
    ["我目前的渠道有哪些？", "渠道清单", "list_channels"],
    ["哪个渠道带来的客户最多？", "渠道清单", "list_channels"],
    ["现在有哪些线索还没跟？", "线索清单", "list_leads"],
    ["手上进行中的商机有几个，加起来多少钱？", "商机清单", "list_opportunities"],
    ["这个月谁签得最多？", "本月签约按销售", "query_metric"],
    ["本月签约金额按销售分一下", "本月签约按销售", "query_metric"],
    ["今天我最该跟进谁？", "今天跟谁", "get_my_plans"],
    ["有哪些客户很久没跟了？", "盯盘", "get_watchlist"],
    ["谁提到过预算？", "谁提到过某个词", "search_followups"],
  ];
  for (const [问, 名, 首个工具] of 样本) {
    it(`「${问}」→ ${名}`, () => {
      const r = 认意图(问);
      expect(r?.名).toBe(名);
      expect(r?.调用[0].name).toBe(首个工具);
    });
  }

  it("本月那条自己算好起止日期，不让模型填", () => {
    const args = 认意图("这个月谁签得最多？")!.调用[0].args as { from: string; to: string; metric: string; groupBy: string };
    expect(args.metric).toBe("contract_amount");
    expect(args.groupBy).toBe("sales");
    expect(args.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(args.to.slice(0, 7)).toBe(args.from.slice(0, 7));
  });

  it("「谁提到过 X」把 X 摘出来当关键词", () => {
    const args = 认意图("谁提到过预算？")!.调用[0].args as { keyword: string };
    expect(args.keyword).toBe("预算");
  });
});

describe("不该命中的", () => {
  const 放过: [string, string][] = [
    ["最近怎么样？", "太模糊——没有唯一正确的查询"],
    ["张三这条线怎么接？", "要读记录再判断，是开放问题"],
    ["帮我记一笔今天和李四的电话", "是写入意图，必须走建议卡那条路"],
    ["他呢？", "指代，要靠上文解"],
    ["把陈同学改成已签约", "写入"],
    ["有哪些渠道？另外这个月谁签得最多？", "一句话两个问题，只答一半更糟"],
    ["谁提到过", "关键词是空的"],
  ];
  for (const [问, 为什么] of 放过) {
    it(`「${问}」不命中——${为什么}`, () => {
      expect(认意图(问)).toBeNull();
    });
  }

  it("带了上文一律不命中：指代要靠模型解", () => {
    expect(认意图("我目前的渠道有哪些？")).not.toBeNull();
    expect(认意图("我目前的渠道有哪些？", true)).toBeNull();
  });
});

describe("表本身", () => {
  it("每条规则都写了例子和名字——下一个改它的人要看得懂它挡的是什么", () => {
    for (const it0 of 意图表) {
      expect(it0.名.length).toBeGreaterThan(1);
      expect(it0.例.length).toBeGreaterThan(4);
      expect(it0.工具.length).toBeGreaterThan(0);
    }
  });
});

describe("同义词", () => {
  it("预算连着费用、学费、价格一起搜——库里写「费用」而人问「预算」是常事", () => {
    const w = 扩同义词("预算");
    expect(w[0]).toBe("预算");
    expect(w).toContain("费用");
    expect(w).toContain("学费");
  });

  it("表里没有的词只搜它自己，不猜", () => {
    expect(扩同义词("上岸率")).toEqual(["上岸率"]);
  });

  it("空词返回空，不至于把整库倒出来", () => {
    expect(扩同义词("  ")).toEqual([]);
  });
});
