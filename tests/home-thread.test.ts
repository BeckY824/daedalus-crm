/**
 * 对话线程按「屏」分开存。
 *
 * 2026-09-19 报上来的：在线索页问一句，换到客户页、回到首页，那一问那一答跟着到处走。
 * 根因是这个模块原来就一份 `let turns` + 一份 `let 对话id`，而全局 AI 面板
 * 在**每一页**都渲染同一个 HomeChat，读的是同一份。更隐蔽的是 `对话id`：
 * 线索页问完再去客户页问，两问会落进库里**同一条对话**。
 *
 * 所以这里钉两头：各屏互不相干（独立的是上下文），但都往同一张表落
 * ——首页那条列表照样看得到每一页问过什么，那是要的（用户原话：
 * 「每个页面的聊天独立，但是记录可以留存在首页的 list 里面」）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  addTurn,
  clearThread,
  dequeueTurn,
  removeTurn,
  读屏,
  载入对话,
  认领对话,
  认落,
  当前对话,
  新起一屏,
  清空所有屏,
  首页屏,
} from "@/lib/home-thread";

const 问 = (scope: string, q: string) => addTurn(scope, { question: q, kind: "ask" });
const 问句 = (scope: string) => 读屏(scope).map((t) => t.question);

describe("对话线程按屏分开", () => {
  beforeEach(() => 清空所有屏());

  it("线索页问的那一句，客户页和首页都看不见", () => {
    问("/leads", "Steven是哪家公司的？");
    expect(问句("/leads")).toEqual(["Steven是哪家公司的？"]);
    expect(问句("/customers")).toEqual([]);
    expect(问句(首页屏)).toEqual([]);
  });

  it("各屏各自累积，不互相插队", () => {
    问("/leads", "一");
    问("/customers", "二");
    问("/leads", "三");
    expect(问句("/leads")).toEqual(["一", "三"]);
    expect(问句("/customers")).toEqual(["二"]);
  });

  it("对话 id 一屏一份：线索页认领了，客户页还是空的", () => {
    认领对话("/leads", "conv-leads");
    expect(当前对话("/leads")).toBe("conv-leads");
    expect(当前对话("/customers")).toBeNull();
    expect(当前对话(首页屏)).toBeNull();
  });

  it("首页新起一屏，不动别的页面", () => {
    问(首页屏, "首页问的");
    问("/leads", "线索页问的");
    认领对话(首页屏, "conv-home");
    认领对话("/leads", "conv-leads");

    新起一屏(首页屏);
    expect(问句(首页屏)).toEqual([]);
    expect(当前对话(首页屏)).toBeNull();
    expect(问句("/leads")).toEqual(["线索页问的"]);
    expect(当前对话("/leads")).toBe("conv-leads");
  });

  it("/clear 是清屏不是换对话：turns 空掉，归属还在", () => {
    问("/leads", "一");
    认领对话("/leads", "conv-leads");
    clearThread("/leads");
    expect(问句("/leads")).toEqual([]);
    expect(当前对话("/leads")).toBe("conv-leads");
  });

  it("同一条对话重复载入不重置（正在流的那一轮不能被冲掉）", () => {
    expect(载入对话("/leads", "c1", [])).toBe(true);
    expect(载入对话("/leads", "c1", [])).toBe(false);
    expect(载入对话("/leads", "c2", [])).toBe(true);
  });

  it("增删改都只作用在指定的那一屏", () => {
    const a = 问("/leads", "一");
    问("/customers", "二");
    dequeueTurn("/leads", a.id);
    removeTurn("/leads", a.id);
    expect(问句("/leads")).toEqual([]);
    expect(问句("/customers")).toEqual(["二"]);
  });

  /**
   * 读路径不许建屏。建了的话 getSnapshot 每次返回一个新数组，
   * useSyncExternalStore 判定「变了」，渲染停不下来——白屏加 CPU 跑满。
   */
  it("没问过的屏读出来是同一个空数组", () => {
    expect(读屏("/never")).toBe(读屏("/also-never"));
    expect(当前对话("/never")).toBeNull();
  });
});

/**
 * 一个问题、两条一模一样的回答，连用时都一样（2026-09-19 用户报的截图）。
 *
 * 模型只跑了一次——操作日志里就一条「AI 对话」。多出来的是**落库**那一步：
 * 原来那道「这一轮落过了」的闸是 HomeChat 里的 useRef，跟着组件实例走；
 * 而 turns 和答案都在模块级，活得比组件久。把面板关掉再打开就是一次重挂载，
 * 新实例的闸是空的，看见任务还是 done，同一轮又落一遍。
 *
 * 所以闸挪到了这里，和它守的东西放在一起。
 */
describe("同一轮只落一次库", () => {
  beforeEach(() => 清空所有屏());

  it("第一次认得下，第二次认不下", () => {
    const t = 问("/leads", "Steven是哪家公司的？");
    expect(认落("/leads", t.id)).toBe(true);
    expect(认落("/leads", t.id)).toBe(false);
  });

  it("组件重挂载不会让闸清零（闸在模块级，不在 ref 里）", () => {
    const t = 问("/leads", "问一句");
    expect(认落("/leads", t.id)).toBe(true);
    // 关掉面板再打开 = HomeChat 重挂载。turns 和答案都还在，闸也必须还在
    expect(认落("/leads", t.id)).toBe(false);
  });

  it("各屏各认各的：线索页落过了，客户页同名的另一轮照落", () => {
    const a = 问("/leads", "一");
    const b = 问("/customers", "一");
    expect(认落("/leads", a.id)).toBe(true);
    expect(认落("/customers", b.id)).toBe(true);
  });

  it("从库里读回来的几轮，一载进来就认掉——翻一次历史不该多一份", () => {
    载入对话("/leads", "c1", [
      { id: "m1", question: "库里第一问", kind: "ask", at: 1 },
      { id: "m2", question: "库里第二问", kind: "ask", at: 2 },
    ]);
    expect(认落("/leads", "m1")).toBe(false);
    expect(认落("/leads", "m2")).toBe(false);
  });

  it("换一条对话，闸跟着换——上一条的 id 不挡新这条", () => {
    载入对话("/leads", "c1", [{ id: "m1", question: "旧的", kind: "ask", at: 1 }]);
    载入对话("/leads", "c2", []);
    const t = 问("/leads", "新的");
    expect(认落("/leads", t.id)).toBe(true);
  });
});
