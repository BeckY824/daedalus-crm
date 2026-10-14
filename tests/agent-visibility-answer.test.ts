import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEFAULT_BUSINESS } from "@/lib/business-config";
import { resetDb } from "./reset";

const model = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[], answer: "", answers: [] as string[], prompts: [] as string[] }));
vi.mock("@/lib/llm", () => ({
  buildSystemPrompt: () => "只基于数据回答",
  chatMessagesJSON: async () => ({ final: true }),
  chatTools: async () => {
    const next = model.calls.shift();
    return { text: "", toolCalls: next ? [{ id: "qa-call", function: { name: next.name, arguments: JSON.stringify(next.args) } }] : [] };
  },
  chatTextStream: async (messages: { content: unknown }[], _opts: unknown, token: (t: string) => void) => {
    model.prompts.push(messages.map(m => String(m.content ?? "")).join("\n"));
    const answer = model.answers.shift() ?? model.answer;
    for (const ch of answer) token(ch);
    return answer;
  },
}));
beforeEach(async () => { await resetDb(); model.calls = []; model.answer = ""; model.answers = []; model.prompts = []; });
afterAll(async () => { await prisma.$disconnect(); });
async function ask() {
  const { runAgent } = await import("@/lib/agent/run");
  const tokens: string[] = [];
  const r = await runAgent({ question: "QA-SAM-F1-Win双向客户／13900001611 的资料是什么？", user: { id: "qa-user", name: "QA" }, b: DEFAULT_BUSINESS }, { onToken: t => tokens.push(t) });
  return { ...r, emitted: tokens.join("") };
}
it.each(['query_records', 'find_person', 'get_customer'])("%s 搜空后，模型错误断言不流到界面，也不确认他人持有记录", async name => {
  model.calls = [{ name, args: name === 'query_records' ? { 表: '客户', 条件: [{ 字段: '姓名', 运算: '等于', 值: 'QA-SAM-F1-Win双向客户' }] } : name === 'find_person' ? { name: 'QA-SAM-F1-Win双向客户' } : { id: 'qa-invisible' } }];
  model.answer = '不是权限问题，这个客户在系统里不存在。';
  const r = await ask();
  expect(r.text).toContain('当前可访问范围内未找到');
  expect(r.text).toContain('无法据此区分');
  expect(r.emitted).toBe(r.text);
  expect(r.emitted).not.toContain('不是权限问题');
  expect(r.emitted).not.toContain('系统里不存在');
  expect(r.customers).toEqual([]); expect(r.records).toEqual([]);
  expect(model.prompts[0]).toContain('不能断言全系统不存在');
});
it("一次参数错误后成功搜空，仍按可访问范围表述", async () => {
  model.calls = [
    { name: 'query_records', args: { 表: '客户', 条件: [{ 字段: '不存在的字段', 运算: '等于', 值: 'QA' }] } },
    { name: 'query_records', args: { 表: '客户', 条件: [{ 字段: '姓名', 运算: '等于', 值: 'QA' }] } },
  ];
  model.answer = '这个客户未录入系统，与权限无关。';
  const r = await ask(); expect(r.text).toContain('当前可访问范围内未找到'); expect(r.emitted).toBe(r.text);
});
it("找到记录时保留正常流式回答，后续一次空查询不抹掉已找到的资料", async () => {
  const user = await prisma.user.create({ data: { id: 'qa-user', email: 'qa@example.invalid', name: 'QA', password: 'unused', role: 'ADMIN' } });
  await prisma.customer.create({ data: { name: 'QA可见客户', phone: '13900009991', salesOwnerId: user.id } });
  model.calls = [
    { name: 'query_records', args: { 表: '客户', 条件: [{ 字段: '姓名', 运算: '等于', 值: 'QA可见客户' }] } },
    { name: 'query_records', args: { 表: '客户', 条件: [{ 字段: '姓名', 运算: '等于', 值: 'QA未匹配' }] } },
  ];
  model.answer = 'QA可见客户的电话是13900009991。';
  const r = await ask(); expect(r.text).toBe(model.answer); expect(r.emitted).toBe(model.answer);
});
it("关联联系人为空但另有未归属联系人时，保留额外可见信息", async () => {
  await prisma.unassignedContact.create({ data: { id: 'qa-detached', name: 'QA未归属', ownerId: 'qa-user' } });
  model.calls = [{ name: 'query_records', args: { 表: '联系人', 只计数: true } }];
  model.answer = '关联联系人0位，另有1位未归属联系人。';
  const r = await ask(); expect(r.text).toBe(model.answer); expect(r.emitted).toBe(model.answer);
  expect(model.prompts[0]).toContain('"未归属联系人":1');
});
it("回答回炉再查询仍为空时，无依据的权限断言仍不能流出", async () => {
  model.calls = [{ name: 'get_customer', args: { id: 'qa-invisible' } }];
  model.answers = ['<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="find_person"><｜｜DSML｜｜ parameter name="name" string="true">QA未匹配</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', '不是权限问题，这个客户在系统里不存在。'];
  const r = await ask(); expect(r.text).toContain('当前可访问范围内未找到'); expect(r.emitted).toBe(r.text);
  expect(r.emitted).not.toMatch(/DSML|不是权限问题|系统里不存在/);
});
