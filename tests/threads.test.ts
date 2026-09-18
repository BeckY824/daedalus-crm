/**
 * 首页对话的历史。
 *
 * 在这之前这串问答只活在内存里，刷新即清。落库之后第一件要钉住的事是
 * **只有自己看得见**：托管版一个工作区里有好几个人，问 AI 的过程常常带着
 * 还没想清楚的判断，不该像业务数据那样全员可见。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "", name: "甲", email: "a@x", role: "ADMIN", title: "管理员", avatar: null },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => mocks.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 列对话, 读对话, 新建对话, 落一轮, 重命名对话, 删除对话 } from "@/app/(app)/dashboard/threads";

let 甲: { id: string };
let 乙: { id: string };

/** 换个人再调那些 action，模拟另一个登录会话 */
function 换成(u: { id: string }, name: string) {
  mocks.user = { id: u.id, name, email: name, role: "SALES", title: "销售", avatar: null };
}

beforeEach(async () => {
  await resetDb();
  甲 = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" } });
  乙 = await prisma.user.create({ data: { email: "yi", name: "乙", title: "销售", role: "SALES", password: "x" } });
  换成(甲, "甲");
});

afterAll(async () => { await prisma.$disconnect(); });

describe("落一轮", () => {
  it("没指定对话时自己开一条，标题取这一问", async () => {
    const { conversationId } = await 落一轮({ question: "这个月谁签得最多", answer: "张三" });
    const c = await 读对话(conversationId);
    expect(c?.title).toBe("这个月谁签得最多");
    expect(c?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c?.messages[1].text).toBe("张三");
  });

  it("长问题的标题截到 18 个字", async () => {
    const 长 = "帮我看看这个月所有意向较高的客户里，哪几位已经很久没跟进了，各自该从哪接上";
    const { conversationId } = await 落一轮({ question: 长, answer: "…" });
    const c = await 读对话(conversationId);
    expect(c!.title.length).toBeLessThanOrEqual(19); // 18 个字 + 省略号
    expect(c!.title.startsWith("帮我看看这个月")).toBe(true);
  });

  it("同一条对话里连问两次，两轮都在，顺序不乱", async () => {
    const a = await 落一轮({ question: "第一问", answer: "第一答" });
    await 落一轮({ conversationId: a.conversationId, question: "第二问", answer: "第二答" });
    const c = await 读对话(a.conversationId);
    expect(c!.messages.map((m) => m.text)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
  });

  it("轨迹和涉及到的记录按 JSON 存回来，存坏了也不炸", async () => {
    const { conversationId } = await 落一轮({
      question: "问", answer: "答", model: "glm-5.3-flash", ms: 1234,
      steps: [{ kind: "tool", name: "query_metric" }], refs: [{ id: "c1", name: "张三" }],
    });
    const c = await 读对话(conversationId);
    const a = c!.messages[1];
    expect(a.model).toBe("glm-5.3-flash");
    expect(a.ms).toBe(1234);
    expect(a.steps).toEqual([{ kind: "tool", name: "query_metric" }]);

    // 手工把 JSON 写坏：翻历史时少一行轨迹，总好过整页打不开
    await prisma.aiMessage.update({ where: { id: a.id }, data: { steps: "{不是 JSON" } });
    expect((await 读对话(conversationId))!.messages[1].steps).toBeNull();
  });

  it("给了一条不是自己的对话 id，不会往里塞，而是另开一条", async () => {
    const 乙的 = await prisma.aiConversation.create({ data: { title: "乙的对话", ownerId: 乙.id } });
    const r = await 落一轮({ conversationId: 乙的.id, question: "我的问题", answer: "答" });
    expect(r.conversationId).not.toBe(乙的.id);
    expect(await prisma.aiMessage.count({ where: { conversationId: 乙的.id } })).toBe(0);
  });
});

describe("只有自己看得见", () => {
  beforeEach(async () => {
    await 落一轮({ question: "甲问的", answer: "答" });
    换成(乙, "乙");
    await 落一轮({ question: "乙问的", answer: "答" });
  });

  it("列表只列自己的", async () => {
    expect((await 列对话()).map((c) => c.title)).toEqual(["乙问的"]);
    换成(甲, "甲");
    expect((await 列对话()).map((c) => c.title)).toEqual(["甲问的"]);
  });

  it("拿到别人的 id 也读不出来——管理员也不行", async () => {
    const 乙的 = await prisma.aiConversation.findFirstOrThrow({ where: { ownerId: 乙.id } });
    换成(甲, "甲"); // 甲是 ADMIN
    expect(await 读对话(乙的.id)).toBeNull();
  });

  it("删不掉、也改不了别人的", async () => {
    const 甲的 = await prisma.aiConversation.findFirstOrThrow({ where: { ownerId: 甲.id } });
    // 此刻登录的是乙
    expect((await 删除对话(甲的.id)).ok).toBe(false);
    expect((await 重命名对话(甲的.id, "被改了")).ok).toBe(false);
    expect((await prisma.aiConversation.findUniqueOrThrow({ where: { id: 甲的.id } })).title).toBe("甲问的");
  });
});

describe("列表与增删改", () => {
  it("按最后一次提问倒序，置顶的排在最前面", async () => {
    const 早 = await 落一轮({ question: "早的", answer: "答" });
    const 晚 = await 落一轮({ question: "晚的", answer: "答" });
    /*
      两条是同一毫秒里建的，lastAskedAt 会一模一样——那样这条用例验的就成了
      「SQLite 恰好按什么顺序返回」。把「早的」真的推早一天，验的才是排序本身。
    */
    await prisma.aiConversation.update({ where: { id: 早.conversationId }, data: { lastAskedAt: new Date(Date.now() - 86_400_000) } });
    expect((await 列对话()).map((c) => c.title)).toEqual(["晚的", "早的"]);

    await prisma.aiConversation.update({ where: { id: 早.conversationId }, data: { pinnedAt: new Date() } });
    expect((await 列对话())[0].title).toBe("早的");
    expect(晚.conversationId).toBeTruthy();
  });

  it("重命名不改排序——改个名字不该让老对话跳到最前面", async () => {
    const 早 = await 落一轮({ question: "早的", answer: "答" });
    await 落一轮({ question: "晚的", answer: "答" });
    await prisma.aiConversation.update({ where: { id: 早.conversationId }, data: { lastAskedAt: new Date(Date.now() - 86_400_000) } });
    await 重命名对话(早.conversationId, "改了名的");
    expect((await 列对话()).map((c) => c.title)).toEqual(["晚的", "改了名的"]);
  });

  it("删对话把消息一起带走，不留孤儿", async () => {
    const { conversationId } = await 落一轮({ question: "要删的", answer: "答" });
    expect((await 删除对话(conversationId)).ok).toBe(true);
    expect(await prisma.aiMessage.count({ where: { conversationId } })).toBe(0);
    expect(await 读对话(conversationId)).toBeNull();
  });

  it("新建出来的空对话也在列表里，条数是 0", async () => {
    const { id } = await 新建对话();
    const 那条 = (await 列对话()).find((c) => c.id === id);
    expect(那条?.title).toBe("新对话");
    expect(那条?.条数).toBe(0);
  });
});
