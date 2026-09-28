import { beforeEach, describe, expect, it, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clearJob, getJob, runJob, setJobValue, 任务快照, 收起任务, 建议结果, 记下建议结果 } from "@/lib/ai-jobs";

/**
 * 侧栏那条「AI 任务」（批 2）。
 *
 * 要解决的是：问一句要十几秒，人不会盯着看，他会切去别的页面——
 * 切走之后原来没有任何迹象说明还有东西在跑，回来才发现早答完了。
 * 任务表本身是模块级的，组件卸载不影响它；这里钉的是侧栏读到的那份快照。
 */
const 等一下 = () => new Promise((r) => setTimeout(r, 0));

describe("AI 任务在侧栏里的那一份", () => {
  beforeEach(() => {
    for (const t of 任务快照()) clearJob(t.key);
  });

  test("带标签的才进侧栏：起草话术那种几秒就回来的不占一行", async () => {
    runJob("draft:wakeup:c1", async () => ({ ok: true, value: "话术" }));
    runJob("home:1", async () => ({ ok: true, value: {} }), undefined, { 名: "张悦还能怎么推进", 去: "/dashboard" });
    await 等一下();
    expect(任务快照().map((t) => t.key)).toEqual(["home:1"]);
  });

  test("跑着的排在前面——人最关心的是还有什么没回来", async () => {
    setJobValue("home:done", {});
    runJob("home:running", () => new Promise(() => {}), undefined, { 名: "跑着的", 去: "/dashboard" });
    runJob("home:finished", async () => ({ ok: true, value: {} }), undefined, { 名: "答完的", 去: "/dashboard" });
    await 等一下();
    expect(任务快照()[0].标签.名).toBe("跑着的");
  });

  test("答完但带着建议卡的要标成「需确认」，不能和普通答完混在一起", async () => {
    runJob("home:2", async () => ({ ok: true, value: { answer: { proposals: [{ id: "p1" }] } } }), undefined, { 名: "记一笔", 去: "/dashboard" });
    await 等一下();
    const t = 任务快照().find((x) => x.key === "home:2")!;
    expect(t.status).toBe("done");
    expect(t.有建议).toBe(true);
  });

  test("卡片都处理过（确认或忽略）就不再「等你确认」；还剩一张没处理就还等（2026-09-28 核对教程时看到一直挂着）", async () => {
    runJob("home:4", async () => ({ ok: true, value: { answer: { proposals: [{ id: "p1" }, { id: "p2" }] } } }), undefined, { 名: "记两笔", 去: "/dashboard" });
    await 等一下();
    const 这条 = () => 任务快照().find((x) => x.key === "home:4")!;
    记下建议结果("home:4:p1", "done");
    expect(这条().有建议, "还有 p2 没处理").toBe(true);
    记下建议结果("home:4:p2", "denied");
    expect(这条().有建议).toBe(false);
  });

  test("卡片重挂时照任务表恢复：确认过的不会又变回待确认、能再点一次", async () => {
    记下建议结果("home:5:p1", "done");
    expect(建议结果("home:5:p1")).toBe("done");
    expect(建议结果("home:5:p2")).toBeUndefined();
    // 任务清掉，它名下的记号一起清，不留垃圾
    runJob("home:5", async () => ({ ok: true, value: {} }), undefined, { 名: "x", 去: "/dashboard" });
    await 等一下();
    clearJob("home:5");
    expect(建议结果("home:5:p1")).toBeUndefined();
  });

  test("点开看过就清掉，不会一直堆在侧栏里", async () => {
    runJob("home:3", async () => ({ ok: true, value: {} }), undefined, { 名: "看过就消", 去: "/dashboard" });
    await 等一下();
    expect(任务快照()).toHaveLength(1);
    clearJob("home:3");
    expect(任务快照()).toHaveLength(0);
  });

  test("快照不变时返回同一个引用——每次给新数组会让订阅它的组件无限重渲", async () => {
    runJob("home:4", async () => ({ ok: true, value: {} }), undefined, { 名: "同一份", 去: "/dashboard" });
    await 等一下();
    expect(任务快照()).toBe(任务快照());
  });
});

/**
 * 从侧栏划掉一条任务 ≠ 把答案删掉。
 *
 * 2026-09-19 报上来的：点一下「AI 任务」里那一条，右边面板那条回答当场消失。
 * 因为点的是 `clearJob`——那是把任务整个删掉，而回答正是从这个任务读出来的
 * （HomeChat 里 `useJob("home:" + turn.id)`）。用户想的是「这条我看过了」，
 * 结果连答案一起没了，只好再问一遍——那才是真花钱的。
 */
describe("收起任务", () => {
  beforeEach(() => {
    for (const k of ["home:a", "home:b"]) clearJob(k);
  });

  it("从侧栏列表里消失，但结果还在", () => {
    setJobValue("home:a", { text: "答案还在这儿" });
    // setJobValue 不带标签，先手工造一条带标签的完成态任务
    runJob("home:b", async () => ({ ok: true as const, value: { text: "另一条" } }), undefined, { 名: "问了什么" });
    return new Promise<void>((done) => {
      setTimeout(() => {
        expect(任务快照().some((t) => t.key === "home:b"), "刚跑完的该出现在侧栏").toBe(true);
        收起任务("home:b");
        expect(任务快照().some((t) => t.key === "home:b"), "收起之后不该再出现在侧栏").toBe(false);
        expect(getJob<{ text: string }>("home:b")?.value?.text, "答案不该跟着没了").toBe("另一条");
        expect(getJob("home:b")?.status).toBe("done");
        done();
      }, 20);
    });
  });

  it("还在跑的不许收起——那条得留着让人知道它没完", () => {
    runJob("home:a", () => new Promise(() => {}), undefined, { 名: "还在跑" });
    收起任务("home:a");
    expect(任务快照().some((t) => t.key === "home:a"), "loading 的收起不掉（组件也不给点）").toBe(true);
  });

  it("clearJob 仍然是真删——/clear 那条命令要的就是它", () => {
    setJobValue("home:a", { text: "x" });
    clearJob("home:a");
    expect(getJob("home:a")).toBeUndefined();
  });
});

/**
 * **清掉一个任务，就得同时把那一轮也处理掉。**
 *
 * 2026-09-19 用户的截图：面板里躺着一个光秃秃的问题气泡，底下什么都没有——
 * 没有过程条、没有回答、也没有任何出路。那是 0.39.0 上点一下侧栏「AI 任务」
 * 的后果：点的是 `clearJob`，任务连答案一起被删，而**问题那一轮还留在屏上**。
 * 回答是从任务里读的（`useJob("home:" + turn.id)`），任务没了就等于答案凭空蒸发。
 *
 * 这条规矩不写在类型里、编译器看不见：`clearJob("home:x")` 单独出现永远合法，
 * 只是会在界面上留下一具空壳。所以在这儿按调用点扫一遍——
 * 每一处清 home 任务的地方，附近必须同时把那一轮**去掉、清屏、或者重新跑起来**。
 */
describe("清 home 任务的地方，那一轮不能被撇下", () => {
  const 文件 = ["../src/app/(app)/dashboard/HomeChat.tsx", "../src/app/(app)/dashboard/TurnView.tsx", "../src/app/(app)/dashboard/ConversationList.tsx"];
  /** 清完之后这一轮的去处：去掉它 / 整屏清掉 / 连同屏一起删 / 立刻重新跑 */
  const 去处 = ["removeTurn", "clearThread", "删掉对话的屏", "start("];

  it.each(文件)("%s 里每一处 clearJob(`home:…`) 都给那一轮安排了去处", (相对) => {
    const src = readFileSync(resolve(__dirname, 相对), "utf8");
    const 落单: string[] = [];
    for (const m of src.matchAll(/clearJob\(`home:/g)) {
      const i = m.index!;
      const 附近 = src.slice(Math.max(0, i - 400), i + 400);
      if (!去处.some((k) => 附近.includes(k))) 落单.push(src.slice(i, i + 60).split("\n")[0]);
    }
    expect(落单, `这几处清了任务却没处理那一轮，屏上会留下一个没有回答的问题：\n${落单.join("\n")}`).toEqual([]);
  });

  it("侧栏那条任务点一下走的是「收起」，不是 clearJob——答案不能跟着没", () => {
    const src = readFileSync(resolve(__dirname, "../src/components/AiTasks.tsx"), "utf8");
    expect(src).toContain("收起任务(");
    expect(src).not.toContain("clearJob");
  });
});

describe("跑到一半被清掉 = 作废", () => {
  test("弹窗关了，模型那边照样回来——结果不许写回任务表，侧栏也不许冒出「答完了」", async () => {
    let 放行!: () => void;
    const 等着 = new Promise<void>((r) => (放行 = r));
    runJob("parse:c1", async () => {
      await 等着;
      return { ok: true, value: "草稿" };
    }, undefined, { 名: "解析跟进速记", 去: "/customers/c1" });
    await 等一下();
    expect(getJob("parse:c1")?.status).toBe("loading");

    clearJob("parse:c1");
    放行();
    await 等一下();
    await 等一下();
    expect(getJob("parse:c1")).toBeUndefined();
    expect(任务快照().some((t) => t.key === "parse:c1")).toBe(false);
  });

  test("清掉之后马上重跑：旧那一轮回来得晚，也不能把新那一轮的结果盖掉", async () => {
    let 放旧!: () => void;
    const 旧 = new Promise<void>((r) => (放旧 = r));
    runJob("parse:c2", async () => {
      await 旧;
      return { ok: true, value: "旧的" };
    });
    await 等一下();
    clearJob("parse:c2");
    runJob("parse:c2", async () => ({ ok: true, value: "新的" }));
    await 等一下();
    放旧();
    await 等一下();
    await 等一下();
    expect(getJob<string>("parse:c2")?.value).toBe("新的");
  });
});
