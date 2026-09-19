/**
 * 库里的一条对话 → 屏上的那几轮。
 *
 * 这段原来是 dashboard/HomeChat.tsx 里的一个私有函数、没有用例——因为只有首页
 * 要用它，而首页的会话由服务端读好当 prop 传进来。0.39.2 起面板头上那枚「历史」
 * 也要走同一段（面板是点开才去要数据的，没有那个 prop），于是它挪进了
 * lib/thread-history.ts。两处必须摊成**完全一样**的形状：turn 的 id 决定
 * ai-jobs 的 key（`home:<id>`），差一点就会翻一次历史多出一份任务、
 * 或者答案挂不到那一轮上（屏上表现是「问题在、回答空着」）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { 历史成屏, 载入历史, type 历史消息 } from "@/lib/thread-history";
import { 读屏, 当前对话, 清空所有屏, addTurn } from "@/lib/home-thread";
import { getJob, clearJob } from "@/lib/ai-jobs";
import type { StreamJob } from "@/lib/ai-stream";

/** 库里的一条消息。只写这几个用例关心的字段，其余给默认 */
function 消息(m: Partial<历史消息> & { id: string; role: "user" | "assistant"; text: string }): 历史消息 {
  return { model: null, ms: null, steps: null, refs: null, createdAt: "2026-09-19T10:00:00.000Z", ...m };
}

const 一问一答 = [
  消息({ id: "u1", role: "user", text: "这个月谁签得最多" }),
  消息({ id: "a1", role: "assistant", text: "张三", model: "glm-5.3-flash", ms: 1234 }),
];

beforeEach(() => {
  清空所有屏();
  for (const k of ["home:u1", "home:u2", "home:u3"]) clearJob(k);
});

describe("历史成屏", () => {
  it("一条 user + 紧跟的 assistant = 一轮，turn 的 id 用那条 user 消息的 id", () => {
    const { turns } = 历史成屏(一问一答);
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe("u1");
    expect(turns[0].question).toBe("这个月谁签得最多");
    expect(turns[0].kind).toBe("ask");
    expect(turns[0].at).toBe(Date.parse("2026-09-19T10:00:00.000Z"));
  });

  it("答案挂在 home:<user id> 上，用时和模型都带过来", () => {
    const { jobs } = 历史成屏(一问一答);
    expect(jobs.length).toBe(1);
    // 这个 key 必须和当场问的时候一样，否则刷新一次就会多出一份任务
    expect(jobs[0].key).toBe("home:u1");
    expect(jobs[0].value.text).toBe("张三");
    expect(jobs[0].value.answer?.text).toBe("张三");
    expect(jobs[0].value.ms).toBe(1234);
  });

  it("落单的问题整轮跳过——宁可少一轮，不要一个问着没人答的气泡", () => {
    /*
      两种落单：答之前进程没了（末尾一条 user），
      以及顺序被插花了（user 后面跟着另一条 user）。
    */
    const { turns } = 历史成屏([
      消息({ id: "u1", role: "user", text: "第一问" }),
      消息({ id: "u2", role: "user", text: "第二问" }),
      消息({ id: "a2", role: "assistant", text: "第二答" }),
      消息({ id: "u3", role: "user", text: "没答完就断了" }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u2"]);
  });

  it("头一条就是 assistant（库里的脏数据）不会错位配对", () => {
    const { turns } = 历史成屏([
      消息({ id: "a0", role: "assistant", text: "没头没脑的一条" }),
      ...一问一答,
    ]);
    expect(turns.map((t) => t.id)).toEqual(["u1"]);
  });

  it("轨迹存坏成非数组时给空数组，不炸", () => {
    // 解析失败时 读对话 给的是 null；存成对象也不该让整页打不开
    for (const 坏 of [null, "不是数组", { kind: "tool" }]) {
      const { jobs } = 历史成屏([
        一问一答[0],
        消息({ id: "a1", role: "assistant", text: "答", steps: 坏 }),
      ]);
      expect(jobs[0].value.steps).toEqual([]);
    }
  });

  it("是数组但形状对不上的，那几条丢掉——少一行轨迹好过整页白屏", () => {
    /*
      实测撞出来的：渲染路径上的 summarizeSteps 上来就 `s.id.startsWith(...)`，
      少一个 id 就是运行时 TypeError，**首页和面板一起白屏**。
      `steps` 是一段自由 JSON，写它的是当时那一版代码，读的时候不能假定形状。
      threads.ts 的 解析() 只挡住了「JSON 都解不出来」，这一层补上「解得出来但不对」。
    */
    const { jobs } = 历史成屏([
      一问一答[0],
      消息({
        id: "a1",
        role: "assistant",
        text: "答",
        steps: [
          { kind: "tool", name: "list_leads" },          // 老版本 / 别处写的形状：没有 id
          { id: "tool-1", label: "list_leads({})" },     // 这条是好的
          null,
          { id: 7, label: "id 不是字符串" },
          { id: "tool-2" },                              // 缺 label
        ],
      }),
    ]);
    expect(jobs[0].value.steps).toEqual([{ id: "tool-1", label: "list_leads({})" }]);
  });

  it("refs 缺字段时给空数组；建议卡永远不还原", () => {
    const { jobs } = 历史成屏([
      一问一答[0],
      消息({ id: "a1", role: "assistant", text: "答", refs: { customers: [{ id: "c1", name: "张三", followStatus: "意向较高" }] } }),
    ]);
    expect(jobs[0].value.answer?.records).toEqual([]);
    expect(jobs[0].value.answer?.customers).toEqual([{ id: "c1", name: "张三", followStatus: "意向较高" }]);
    /*
      **建议卡不还原**：那是「要不要写进库」的待办，人当时已经处理过了。
      隔天翻历史再弹一张「点确认就写入」的卡片，等于把一件做完的事重新摆回台面。
    */
    expect(jobs[0].value.answer?.proposals).toEqual([]);
  });

  it("空对话摊出来就是空的", () => {
    expect(历史成屏([])).toEqual({ turns: [], jobs: [] });
  });
});

describe("载入历史", () => {
  it("轮进 home-thread，答案进 ai-jobs，这一屏从此挂在那条对话上", () => {
    expect(载入历史("/leads", { id: "c1", title: "线索 · 问", messages: 一问一答 })).toBe(true);
    expect(读屏("/leads").map((t) => t.id)).toEqual(["u1"]);
    expect(当前对话("/leads")).toBe("c1");
    const job = getJob<StreamJob<{ text: string }>>("home:u1");
    expect(job?.status).toBe("done");
    expect(job?.value?.answer?.text).toBe("张三");
  });

  it("同一条对话再载一遍不动屏——正在流的那一轮不能被冲掉", () => {
    载入历史("/leads", { id: "c1", title: "t", messages: 一问一答 });
    // 装载之后又问了一句，这一轮还在跑（不在库里）
    addTurn("/leads", { question: "追问", kind: "ask" });
    expect(载入历史("/leads", { id: "c1", title: "t", messages: 一问一答 })).toBe(false);
    expect(读屏("/leads").map((t) => t.question)).toEqual(["这个月谁签得最多", "追问"]);
  });

  it("换一条对话就真的换内容", () => {
    载入历史("/leads", { id: "c1", title: "t", messages: 一问一答 });
    const 另一条 = [消息({ id: "u2", role: "user", text: "另一条里的问" }), 消息({ id: "a2", role: "assistant", text: "另一条里的答" })];
    expect(载入历史("/leads", { id: "c2", title: "t2", messages: 另一条 })).toBe(true);
    expect(读屏("/leads").map((t) => t.id)).toEqual(["u2"]);
    expect(当前对话("/leads")).toBe("c2");
  });

  it("各屏互不相干：在线索页载入的，客户页那一屏看不到", () => {
    载入历史("/leads", { id: "c1", title: "t", messages: 一问一答 });
    expect(读屏("/customers")).toEqual([]);
    expect(当前对话("/customers")).toBeNull();
  });
});
