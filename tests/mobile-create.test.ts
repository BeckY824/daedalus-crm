/**
 * 手机上新建客户 / 商机的规矩（lib/mobile/sync.ts，2026-10-19 客户反馈第 7 条）：和电脑上的新建框一样挡，
 * 只写本人名下；挡住的不进待推。同步到电脑那一段见 tests/team-notice-mobile-create.test.ts
 */
import { describe, expect, it } from "vitest";
import * as 手机 from "@/lib/mobile/sync";

const 机 = { teamId: "t1", device: "m_phone", key: "", epoch: 0, keys: {}, userId: "acct_li", 私钥: new Uint8Array() } as unknown as 手机.手机团队;
const 钟 = { 钟: { name: "x" } };
async function 新手机(业务?: Record<string, unknown>) {
  const 库 = new 手机.内存库();
  const 状态 = 手机.新状态();
  await 库.放({ t: "User", k: "acct_li", r: { id: "acct_li", name: "李娜" }, ...钟 });
  if (业务) await 库.放({ t: "Setting", k: "business", r: { key: "business", value: JSON.stringify(业务) }, ...钟 });
  return { 库, 状态 };
}
const 外贸 = { template: "trade", currency: "EUR" };

describe("手机新建客户", () => {
  it("外贸：电话、WhatsApp、邮箱至少一个；只有邮箱的按邮箱认，电话空着", async () => {
    const { 库, 状态 } = await 新手机(外贸);
    await expect(手机.新建客户(机, 库, 状态, { name: "Acme" })).rejects.toThrow("电话 / WhatsApp / 邮箱 / 微信 / 阿里 ID 至少填一个");
    await expect(手机.新建客户(机, 库, 状态, { name: "   ", email: "a@b.co" })).rejects.toThrow("请填写名字");
    await expect(手机.新建客户(机, 库, 状态, { name: "Acme", email: "不是邮箱" })).rejects.toThrow("邮箱格式不对");
    await expect(手机.新建客户(机, 库, 状态, { name: "Acme", whatsapp: "abc123" })).rejects.toThrow("WhatsApp");
    expect(状态.待推).toEqual([]);
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "Acme", email: "buy@acme.example", country: "UK", source: "展会获取" }, 1_760_000_000_000);
    expect((await 库.取("Customer", id))?.r).toMatchObject({ name: "Acme", phone: "", salesOwnerId: "acct_li", createdAt: 1_760_000_000_000, updatedAt: 1_760_000_000_000 });
    expect((await 库.取("CustomerExtra", id))?.r).toMatchObject({ email: "buy@acme.example", country: "英国", source: "展会获取", whatsapp: null, wechat: null });
    expect(状态.待推.map((e) => e.t)).toEqual(["Customer", "CustomerExtra", "AuditLog"]);
    expect(状态.待推[2].r).toMatchObject({ action: "create", entity: "Customer", entityId: id, userId: "acct_li", userName: "李娜", summary: "新建客户「Acme」" });
    // 每一列都给了：电脑上按原样插入，少一列 NOT NULL 就落不下
    expect(Object.keys(状态.待推[0].r!).sort()).toEqual(["attributionChannelId", "attributionCustomerId", "channelId", "channelOwnerId", "createdAt", "decisionStatus", "expectedSignAt", "expectedSignOn", "followStatus", "grade", "id", "major", "name", "phone", "referrerCustomerId", "remark", "salesOwnerId", "school", "updatedAt"]);
  });

  it("外贸：没电话填了 WhatsApp，WhatsApp 当电话认人；手机上已有的同号、同邮箱挡住", async () => {
    const { 库, 状态 } = await 新手机(外贸);
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "Nord", whatsapp: "+49 151 000 1111" });
    expect((await 库.取("Customer", id))?.r.phone).toBe("+491510001111");
    await expect(手机.新建客户(机, 库, 状态, { name: "Nord 2", phone: "+49 (151) 000-1111" })).rejects.toThrow("已经有了：Nord");
    await 手机.新建客户(机, 库, 状态, { name: "Mail Only", email: "Info@Mail.example" });
    await expect(手机.新建客户(机, 库, 状态, { name: "Mail 2", email: "info@mail.example" })).rejects.toThrow("邮箱 info@mail.example 已经有了：Mail Only");
    // 有电话的不拿邮箱挡（同一公司几位联系人共用 info@）
    await expect(手机.新建客户(机, 库, 状态, { name: "Mail 3", phone: "+44 20 7000 0000", email: "info@mail.example" })).resolves.toBeTruthy();
  });

  it("和电脑上新建客户同一套格子（10-20）：公司 / 职位 / 行业 / 客户等级 / 两个状态存进同名的列；不填就是电脑上的默认值", async () => {
    const { 库, 状态 } = await 新手机(外贸);
    const { id } = await 手机.新建客户(机, 库, 状态, {
      name: "李瑞俊（이서준）", phone: "+82 10 2345 6789", school: " 海潭食品（해담식품） ", grade: "代理（대리）", major: "制造业",
      level: "b", followStatus: "已加微信", decisionStatus: "与家人商议",
    });
    expect((await 库.取("Customer", id))?.r).toMatchObject({ school: "海潭食品（해담식품）", grade: "代理（대리）", major: "制造业", followStatus: "已加微信", decisionStatus: "与家人商议" });
    expect((await 库.取("CustomerExtra", id))?.r).toMatchObject({ level: "B" });
    const { id: 默认 } = await 手机.新建客户(机, 库, 状态, { name: "Acme", phone: "+44 20 7000 0002", school: "  " });
    expect((await 库.取("Customer", 默认))?.r).toMatchObject({ school: null, grade: null, major: null, followStatus: "待跟进", decisionStatus: "了解中" });
    expect(await 库.取("CustomerExtra", 默认)).toBeUndefined();
    await expect(手机.新建客户(机, 库, 状态, { name: "X", phone: "+44 20 7000 0003", followStatus: "瞎填" })).rejects.toThrow("跟进状态「瞎填」不是合法取值");
    await expect(手机.新建客户(机, 库, 状态, { name: "X", phone: "+44 20 7000 0003", decisionStatus: "瞎填" })).rejects.toThrow("决策状态「瞎填」不是合法取值");
    await expect(手机.新建客户(机, 库, 状态, { name: "X", phone: "+44 20 7000 0003", level: "E" })).rejects.toThrow("客户等级");
  });

  it("外贸：只有微信号也能建（电脑上 10-19 同一条），手机上已有的同微信号挡住", async () => {
    const { 库, 状态 } = await 新手机(外贸);
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "王总", wechat: "WangZong88" });
    expect((await 库.取("Customer", id))?.r.phone).toBe("");
    expect((await 库.取("CustomerExtra", id))?.r.wechat).toBe("WangZong88");
    await expect(手机.新建客户(机, 库, 状态, { name: "王总 2", wechat: "wangzong88" })).rejects.toThrow("微信 wangzong88 已经有了：王总");
    // 有电话的不拿微信挡
    await expect(手机.新建客户(机, 库, 状态, { name: "王总 3", phone: "+86 139 0000 1111", wechat: "wangzong88" })).resolves.toBeTruthy();
  });

  it("通用模版（没同步到业务设置也按通用）：电话必填，不写外贸档案", async () => {
    const { 库, 状态 } = await 新手机();
    await expect(手机.新建客户(机, 库, 状态, { name: "张同学", email: "a@b.co" })).rejects.toThrow("请输入联系电话");
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "张同学", phone: "138 0000 1111", country: "中国" });
    expect(await 库.取("CustomerExtra", id)).toBeUndefined();
    expect(状态.待推.map((e) => e.t)).toEqual(["Customer", "AuditLog"]);
  });
});

describe("手机新建商机", () => {
  it("归本人、本位币、按阶段给概率；赢单、负数、公海客户、不在手机上的客户都挡", async () => {
    const { 库, 状态 } = await 新手机(外贸);
    const { id: 客户 } = await 手机.新建客户(机, 库, 状态, { name: "Acme", phone: "+44 20 7000 0001" });
    await 库.放({ t: "Customer", k: "pool", r: { id: "pool", name: "公海的", phone: "", salesOwnerId: "acct_boss" }, ...钟 });
    await 库.放({ t: "CustomerPool", k: "pool", r: { customerId: "pool" }, ...钟 });
    const 前 = 状态.待推.length;
    await expect(手机.新建商机(机, 库, 状态, { customerId: 客户, name: "X", amount: 1, stage: "赢单成交" })).rejects.toThrow("阶段");
    await expect(手机.新建商机(机, 库, 状态, { customerId: 客户, name: "X", amount: -1, stage: "初步沟通" })).rejects.toThrow("负数");
    await expect(手机.新建商机(机, 库, 状态, { customerId: 客户, name: " ", amount: 1, stage: "初步沟通" })).rejects.toThrow("商机名称");
    await expect(手机.新建商机(机, 库, 状态, { customerId: "pool", name: "X", amount: 1, stage: "初步沟通" })).rejects.toThrow("公海");
    await expect(手机.新建商机(机, 库, 状态, { customerId: "nope", name: "X", amount: 1, stage: "初步沟通" })).rejects.toThrow("不在这台手机上");
    expect(状态.待推.length).toBe(前);
    expect(手机.手机商机阶段).not.toContain("赢单成交");
    const { id } = await 手机.新建商机(机, 库, 状态, { customerId: 客户, name: " 面板灯 ", amount: 1234.567, stage: "需求确认" }, 1_760_000_000_000);
    expect((await 库.取("Opportunity", id))?.r).toMatchObject({ name: "面板灯", amount: 1234.57, stage: "需求确认", status: "OPEN", probability: 40, ownerId: "acct_li", customerId: 客户, activityAt: 1_760_000_000_000 });
    expect((await 库.取("OpportunityMoney", id))?.r).toEqual({ opportunityId: id, currency: "EUR" });
    expect(状态.待推.slice(前).map((e) => e.t)).toEqual(["Opportunity", "OpportunityMoney", "AuditLog"]);
    expect(状态.待推.at(-1)!.r!.summary).toMatch(/^新建商机「面板灯」：需求确认 · /);
  });
});
