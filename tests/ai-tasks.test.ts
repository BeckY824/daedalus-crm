import { beforeEach, describe, expect, test } from "vitest";
import { clearJob, runJob, setJobValue, 任务快照 } from "@/lib/ai-jobs";

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
