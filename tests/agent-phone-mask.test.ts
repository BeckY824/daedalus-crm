/**
 * AI 工具吐出来的手机号也要打码。
 *
 * 2026-09-19 补的洞。`lib/shared-ws/current.ts` 的注释写着
 * 「客户列表、联系人、记录页**三处**共用同一个出口」——而 AI 工具是
 * **没人接上的第四个出口**，MCP 是第五个。
 *
 * 网页那个共享工作区是多个团队共用一套账号密码进来的（见记忆 web-trial-shared-workspace）：
 * 表格里显示 `139****1111`，问一句 AI 却能拿到完整号码，而且它会原样写进回答、
 * 写进对话存档（AiMessage），备份里也就有了。数据多半是编的，
 * 但一串 11 位数字在截图和录屏里与真号无从分辨——这正是当初要打码的理由。
 *
 * hosted 的 e2e 只验了表格那一处，验不到这里。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { TOOL_MAP, type ToolContext } from "@/lib/agent/tools";
import { maskPhone } from "@/lib/utils";

const 真号 = "13900001111";
let sales: { id: string; name: string };

/** 共享区的 ctx：带脱敏器。自部署的不带，两种都要验 */
const ctx = (打码: boolean): ToolContext => ({
  userId: sales.id,
  userName: sales.name,
  b: { customer: "学员", brief: "", statusLabels: {}, 术语: {} } as never,
  recordOffset: 0,
  proposals: [],
  号: 打码 ? (<T extends string | null>(p: T): T => (p ? (maskPhone(p) as T) : p)) : undefined,
});

const 跑 = (名: string, args: Record<string, unknown>, 打码: boolean) => TOOL_MAP.get(名)!.run(args, ctx(打码));
/** 把结果整个拍平成字符串——号码藏在哪一层都躲不掉 */
const 全文 = (r: { summary: string; data: unknown }) => `${r.summary}\n${JSON.stringify(r.data)}`;

beforeEach(async () => {
  await resetDb();
  sales = await prisma.user.create({
    data: { email: `s${Date.now()}@t.com`, password: "x", name: "张三", role: "SALES" },
  });
  const 渠道 = await prisma.channel.create({
    data: { name: "小红老师", phone: 真号, channelOwnerId: sales.id },
  });
  const 客户 = await prisma.customer.create({
    data: { name: "钱同学", phone: 真号, salesOwnerId: sales.id, school: "武汉大学", channelId: 渠道.id },
  });
  await prisma.contact.create({ data: { name: "母亲", phone: 真号, customerId: 客户.id, isPrimary: true } });
  await prisma.lead.create({ data: { name: "线索-钱同学", contact: "钱家长", phone: 真号, ownerId: sales.id } });
});

afterAll(async () => void (await prisma.$disconnect()));

/** 每个会吐电话的工具都要验一遍——漏一个就是漏一个出口 */
const 会吐电话的: { 名: string; args: Record<string, unknown> }[] = [
  { 名: "search_customers", args: { query: "钱同学" } },
  { 名: "get_customer", args: { name: "钱同学" } },
  { 名: "list_channels", args: {} },
  { 名: "list_leads", args: {} },
  { 名: "query_records", args: { 表: "客户", 条件: [{ 字段: "姓名", 运算: "包含", 值: "钱" }] } },
  { 名: "query_records", args: { 表: "联系人", 条件: [{ 字段: "姓名", 运算: "包含", 值: "母" }] } },
  { 名: "query_records", args: { 表: "线索", 条件: [{ 字段: "联系人", 运算: "包含", 值: "钱" }] } },
  { 名: "query_records", args: { 表: "渠道", 条件: [{ 字段: "名称", 运算: "包含", 值: "小红" }] } },
];

describe("共享工作区：工具结果里不许出现完整号码", () => {
  for (const { 名, args } of 会吐电话的) {
    const 标 = `${名}${args.表 ? `（${args.表}）` : ""}`;
    it(`${标} 打码`, async () => {
      const t = 全文(await 跑(名, args, true));
      expect(t, `${标} 把完整号码吐出来了`).not.toContain(真号);
      expect(t, `${标} 连打码后的号码都没有——是不是根本没查到？用例就失效了`).toContain(maskPhone(真号));
    });
  }
});

describe("自部署实例：原样给真号", () => {
  for (const { 名, args } of 会吐电话的) {
    const 标 = `${名}${args.表 ? `（${args.表}）` : ""}`;
    it(`${标} 不打码`, async () => {
      // 销售要照着这个号打电话。打码只针对那个多团队共用的工作区
      expect(全文(await 跑(名, args, false)), `${标} 在自部署实例上也打码了`).toContain(真号);
    });
  }
});

/**
 * 这道守卫防的是「以后又加一个吐电话的工具，没人想起来接脱敏器」。
 * 和白名单那几份清单是同一类洞：不报错，只是那个出口悄悄漏了。
 */
describe("别再长出第六个出口", () => {
  it("tools.ts 里凡是写了 phone 的地方，都要经过 号()", async () => {
    const src = (await import("node:fs")).readFileSync(
      new URL("../src/lib/agent/tools.ts", import.meta.url),
      "utf8",
    );
    /**
     * 具名例外。**每一条都要写清为什么**——没有理由的例外等于把守卫关掉。
     */
    const 例外 = [
      { 记: '"phone": "电话，可空"', 因: "propose_lead 的 args 样例，是给模型看的输入说明，不是输出" },
      { 记: '"ownerName": "新的渠道负责人姓名，可空"', 因: "propose_channel_update 的 args 样例，同上" },
      { 记: "phone: found.phone ?? \"\"", 因: "建议卡的预填值，人点确认后原样写回库——打了码就是把假号存进去" },
    ];
    const 可疑: string[] = [];
    // 注释里提 phone 不算（这一段的说明本身就在讲 phone）。块注释要跟状态：
    // `/* … */` 里面的行不带 `*` 前缀，光看行首判断不出来
    let 注释中 = false;
    src.split("\n").forEach((行, i) => {
      const 有开 = 行.includes("/*");
      const 有闭 = 行.includes("*/");
      const 本行在注释里 = 注释中 || 有开;
      if (有开 && !有闭) 注释中 = true;
      if (有闭) 注释中 = false;
      if (本行在注释里 || /^\s*\/\//.test(行)) return;

      if (!/phone/.test(行)) return;
      // 取数（select / where）不往外吐，不算
      if (/select:|contains: q|phone: true|const 是电话|列 === "phone"/.test(行)) return;
      if (例外.some((e) => 行.includes(e.记))) return;
      if (!/号\(/.test(行)) 可疑.push(`${i + 1}: ${行.trim().slice(0, 100)}`);
    });
    expect(可疑, `这几行把 phone 往外吐却没走 号()：\n${可疑.join("\n")}`).toEqual([]);
  });
});
