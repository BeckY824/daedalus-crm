/**
 * 手机库的行 → 界面（lib/mobile/view.ts）：电脑同步来的（毫秒数、0/1）和手机自己记的（毫秒数、true/false）一样读；
 * 「今天」只算我的计划；搜索认电话里的空格和横线。
 */
import { describe, expect, it } from "vitest";
import { 分表, 客户们, 今天要跟, 搜, 毫秒, 真, 国旗, 同步条, 首次同步失败, 要清掉 } from "@/lib/mobile/view";
import { 上次成功, type 记录 } from "@/lib/mobile/sync";
import { 到期话, 没开通话 } from "@/lib/team-pricing";

const 今早 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const 行 = (t: string, r: Record<string, unknown>): 记录 => ({ t, k: String(r.id ?? r.customerId ?? r.opportunityId), r, 钟: {} });
const 我 = "acct_li";
const 数据 = [
  行("User", { id: 我, name: "小李" }), 行("User", { id: "acct_boss", name: "老板" }),
  行("Customer", { id: "c1", name: "Atlas Home", phone: "+1 415-555 0132", salesOwnerId: 我, followStatus: "意向较高" }),
  行("CustomerExtra", { customerId: "c1", country: "美国", whatsapp: "+14155550132" }),
  行("Contact", { id: "k1", customerId: "c1", name: "Maria", position: "采购", isPrimary: 1 }),
  行("FollowUp", { id: "f1", customerId: "c1", ownerId: 我, type: "SMS", content: "旧的", occurredAt: 今早 - 3 * 86400_000 }),
  行("FollowUp", { id: "f2", customerId: "c1", ownerId: "acct_boss", type: "PHONE", content: "老板打的", occurredAt: 今早 - 86400_000 }),
  行("FollowPlan", { id: "p1", customerId: "c1", ownerId: 我, subject: "过期的", plannedAt: 今早 - 86400_000, done: 0 }),
  行("FollowPlan", { id: "p0", customerId: "c1", ownerId: 我, subject: "做完了", plannedAt: 今早 - 5 * 86400_000, done: 1 }),
  行("Opportunity", { id: "o1", customerId: "c1", name: "春季", amount: 186000, stage: "方案报价", status: "OPEN" }),
  行("OpportunityMoney", { opportunityId: "o1", currency: "USD" }),
  行("Customer", { id: "c2", name: "Nordlicht", salesOwnerId: 我 }),
  行("FollowPlan", { id: "p2", customerId: "c2", ownerId: 我, subject: "今天的", plannedAt: 今早 + 15 * 3600_000, done: false }),
  行("Customer", { id: "c3", name: "老板的客户", salesOwnerId: "acct_boss" }),
  行("FollowPlan", { id: "p3", customerId: "c3", ownerId: "acct_boss", subject: "老板的计划", plannedAt: 今早 + 3600_000, done: 0 }),
  行("Customer", { id: "c4", name: "公海客户", salesOwnerId: "acct_boss" }),
  行("CustomerPool", { customerId: "c4", reason: "手动" }),
];

describe("手机界面的数据", () => {
  const cs = 客户们(分表(数据), 我, new Set(["f1"]));
  const c1 = cs.find((c) => c.id === "c1")!;
  it("客户：额外信息、联系人、商机币种、跟进按时间倒序、谁记的、待同步", () => {
    expect(c1).toMatchObject({ country: "美国", whatsapp: "+14155550132", status: "意向较高", 公海: false, 负责人: "我" });
    expect(c1.联系人[0]).toMatchObject({ name: "Maria", title: "采购", 主要: true });
    expect(c1.商机).toMatchObject({ name: "春季", amount: 186000, currency: "USD", stage: "方案报价" });
    expect(c1.跟进.map((x) => [x.id, x.by, x.待同步])).toEqual([["f2", "老板", false], ["f1", "我", true]]);
    expect(c1.计划).toMatchObject({ id: "p1" }); // 做完的（done = 1）不算
    expect(cs.find((c) => c.id === "c4")!.公海).toBe(true);
  });
  it("今天：只算我的计划，公海不算；过期 / 今天分开", () => {
    const t = 今天要跟(cs, 我);
    expect(t.过期.map((c) => c.id)).toEqual(["c1"]);
    expect(t.今天.map((c) => c.id)).toEqual(["c2"]);
    expect([...t.过期, ...t.今天, ...t.之后].map((c) => c.id)).not.toContain("c3");
  });
  it("搜索：名字、国家、联系人；电话忽略空格横线", () => {
    expect(搜(cs, "atlas").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "美国").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "maria").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "4155550132").map((c) => c.id)).toEqual(["c1"]);
    expect(搜(cs, "555 0132").map((c) => c.id)).toEqual(["c1"]);
  });
  it("读值：毫秒数、ISO 字符串、0/1 都认", () => {
    expect(毫秒(1760500000000)).toBe(1760500000000);
    expect(毫秒("1760500000000")).toBe(1760500000000);
    expect(毫秒("2026-10-15T00:00:00.000Z")).toBe(Date.parse("2026-10-15T00:00:00.000Z"));
    expect(毫秒(null)).toBeNull();
    expect([真(1), 真(true), 真("1"), 真(0), 真(false), 真(null)]).toEqual([true, true, true, false, false, false]);
    expect(国旗("美国")).toBe("🇺🇸");
    expect(国旗("火星")).toBe("");
  });
});

/**
 * 同步状态条（2026-10-15）：团队到期被服务端拒了，手机首页还写「已同步 · 刚刚」。
 * 错误文字直接用服务端那几句（team-pricing.ts），服务端改了说法这里会先红
 */
describe("同步状态条", () => {
  const 现在 = Date.parse("2026-10-15T10:00:00Z");
  const 平 = { 断网: false, 待同步: 0, 在同步: false, 上次成功: 现在 - 20_000, 错误: null as string | null, 现在 };
  const 到期 = 到期话(new Date("2026-10-14T15:59:59.999Z"));

  it("正常：已同步 · 多久前", () => {
    expect(同步条(平)).toEqual({ 样子: "ok", 字: "已同步 · 刚刚" });
    expect(同步条({ ...平, 在同步: true }).字).toBe("同步中");
    expect(同步条({ ...平, 待同步: 2 }).字).toBe("2 条同步中");
    expect(同步条({ ...平, 上次成功: null })).toEqual({ 样子: "wait", 字: "还没同步" });
    // 界面的「现在」30 秒才走一次：刚同步完的时间比它新，也算「刚刚」
    expect(同步条({ ...平, 上次成功: 现在 + 25_000 }).字).toBe("已同步 · 刚刚");
  });

  it("团队到期：暂停同步，点开说续费后自动恢复、手机上照常能看；同步中、有待推也不改口", () => {
    const x = 同步条({ ...平, 错误: 到期 });
    expect(x).toMatchObject({ 样子: "stop", 字: "团队已到期，暂停同步" });
    expect(x.详!.原因).toContain("2026-10-14");
    expect(x.详!.怎么办).toContain("续费后自动恢复，这台手机上的内容照常能看");
    expect(x.详!.怎么办).not.toContain("电脑");
    expect(同步条({ ...平, 错误: 到期, 在同步: true }).字).toBe("团队已到期，暂停同步");
    const 有待推 = 同步条({ ...平, 错误: 到期, 待同步: 3 });
    expect(有待推.字).toBe("团队已到期，暂停同步");
    expect(有待推.详!.怎么办).toContain("新记的 3 条先存在这台手机上");
  });

  it("没开通 / 停用：团队没开通，暂不同步", () => {
    const x = 同步条({ ...平, 错误: 没开通话 });
    expect(x).toMatchObject({ 样子: "stop", 字: "团队没开通，暂不同步" });
    expect(x.详!.怎么办).toContain("开通后自动开始同步");
  });

  it("断网：离线（不当成出错弹详情）；其它错误：同步没成功，详情里带原话", () => {
    expect(同步条({ ...平, 断网: true, 待同步: 1 })).toEqual({ 样子: "off", 字: "离线 · 1 条待同步" });
    expect(同步条({ ...平, 错误: "连不上网络" })).toEqual({ 样子: "off", 字: "离线" });
    const x = 同步条({ ...平, 错误: "拉取失败（500）" });
    expect(x).toMatchObject({ 样子: "off", 字: "同步没成功" });
    expect(x.详!.原因).toBe("拉取失败（500）");
    // 断网优先：到期了又断网，先说离线
    expect(同步条({ ...平, 断网: true, 错误: 到期 }).样子).toBe("off");
  });

  it("第一次同步就失败：按原因说，不提「这台电脑」、也不说内容照常能看（手机上还什么都没有）", () => {
    const x = 首次同步失败(到期);
    expect(x.标题).toBe("团队同步已到期");
    expect(x.话).toContain("2026-10-14");
    expect(x.话).toContain("续费后点「再试一次」就行");
    expect(x.话).not.toMatch(/电脑|照常/);
    expect(首次同步失败(没开通话).标题).toBe("团队同步没开通");
    expect(首次同步失败("连不上网络").标题).toBe("没连上网络");
    expect(首次同步失败("拉取失败（500）")).toEqual({ 标题: "没同步下来", 话: "拉取失败（500）" });
  });

  it("上次成功：只认成功的那次；老状态没有 lastOkAt，出着错就当不知道", () => {
    const t = "2026-10-15T09:00:00.000Z";
    expect(上次成功({ lastOkAt: t, lastSyncAt: "2026-10-15T09:59:00.000Z", lastError: 到期 })).toBe(Date.parse(t));
    expect(上次成功({ lastSyncAt: t, lastError: null })).toBe(Date.parse(t));
    expect(上次成功({ lastSyncAt: t, lastError: 到期 })).toBeNull();
    expect(上次成功({})).toBeNull();
  });
});

describe("什么时候把手机上的数据清掉（2026-10-16 团队版全面检验）", () => {
  it("登录失效、人不在团队里了、这台被移除了：清；到期、没开通、断网、别的出错：不清", () => {
    expect(要清掉("登录已失效，请重新登录")).toMatch(/已经清掉/);
    // 服务端 tenant/sync-scoped.ts 核设备 / auth 的原话
    expect(要清掉("你不在这个团队里了：可能被老板移出了，或者你在别的设备上退出了团队")).toMatch(/不在这个团队里了.*已经清掉/);
    expect(要清掉("你不在这个团队里")).toMatch(/已经清掉/);
    expect(要清掉("这台设备已经从「我的设备」里移除，不能再同步：在「设置 → 团队」里点「退出团队」（只清这台电脑），再重新连接")).toMatch(/被移除了.*已经清掉/);
    for (const x of [到期话(new Date("2026-10-15T15:00:00Z")), 没开通话, "连不上网络", "拉取失败（500）", "团队换过钥匙了，这台手机没拿到新钥匙：在电脑上重新授权这台手机"]) expect(要清掉(x), x).toBeNull();
  });
});
