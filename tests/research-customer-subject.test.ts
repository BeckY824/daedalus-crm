/**
 * 客户页点「背调」查谁（10-21 客户反馈）：线上第一次真实背调，客户名 ZEESHAN AFZAL 被当成公司查，
 * 公司 ISHA.A SAS（法国）没去查，报告还写成巴基斯坦。根因：AiPanel 把客户名当 company 传，服务器照收。
 *
 * 现在背调谁以档案为准（lib/research/subject.ts），服务器（stream.ts 背调一次）不信浏览器传的公司名：
 *   有公司 → 主体是公司，客户名是联系人；没公司有电话 → 先找公司；都没有 → 不跑、不扣
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { 客户背调对象, 对象说明 } from "@/lib/research/subject";

const h = vi.hoisted(() => ({
  客户: null as Record<string, unknown> | null,
  跑背调: vi.fn(),
  找公司: vi.fn(),
  选通道: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/ai-quota", () => ({ consumeUserAiQuota: () => null }));
vi.mock("@/lib/ai-usage", () => ({ recordAiUse: vi.fn() }));
vi.mock("@/lib/business", async () => {
  const { DEFAULT_BUSINESS } = await import("@/lib/business-config");
  return { getBusiness: async () => DEFAULT_BUSINESS };
});
vi.mock("@/lib/prisma", () => ({ prisma: { customer: { findUnique: vi.fn(async () => h.客户) } } }));
vi.mock("@/lib/research/channel", () => ({ 选通道: h.选通道 }));
vi.mock("@/lib/research/similar", () => ({ 老客户清单: async () => [] }));
vi.mock("@/lib/research/run", () => ({ 跑背调: h.跑背调 }));
vi.mock("@/lib/research/person", async (orig) => ({ ...(await orig<typeof import("@/lib/research/person")>()), 找公司: h.找公司 }));

const { 背调一次 } = await import("@/lib/research/stream");
const { 初始状态 } = await import("@/lib/research/state");

/** 线上那位客户的档案（10-21，总控给的字段） */
const 那位 = {
  id: "c-zeeshan",
  name: "ZEESHAN AFZAL",
  school: "ISHA.A SAS",
  phone: "+33616988559",
  remark: "we are france base",
  extra: { country: "法国", email: null, whatsapp: "+33616988559", website: null },
};

beforeEach(() => {
  h.客户 = structuredClone(那位);
  h.跑背调.mockReset().mockImplementation(async (input: { 公司: string; 客户?: { id: string }; 联系人?: string }) => ({
    ok: true,
    状态: 初始状态({ name: input.公司, customerId: input.客户?.id, ...(input.联系人 ? { 联系人: input.联系人 } : {}) }),
  }));
  h.找公司.mockReset();
  h.选通道.mockReset().mockResolvedValue({ ok: true, 通道: { 名: "模拟", 扣次: 1 } });
});

const 跑 = (body: Record<string, unknown>) => 背调一次(body as Parameters<typeof 背调一次>[0], () => {}, new AbortController().signal);

describe("服务器：客户页发起的背调以档案为准", () => {
  it("ZEESHAN AFZAL / ISHA.A SAS：浏览器照老样子传客户名，主体也是公司 ISHA.A SAS，客户名是联系人", async () => {
    const r = await 跑({ company: "ZEESHAN AFZAL", customerId: 那位.id });
    expect(r.ok).toBe(true);
    expect(h.跑背调).toHaveBeenCalledTimes(1);
    const input = h.跑背调.mock.calls[0][0];
    expect(input.公司).toBe("ISHA.A SAS");
    expect(input.联系人).toBe("ZEESHAN AFZAL");
    expect(input.客户.已知).toContain("联系人 ZEESHAN AFZAL");
    expect(input.客户.已知).toContain("国家 法国");
    expect(input.客户.已知).toContain("we are france base");
    // 电话 / WhatsApp 当线索去核
    expect(input.线索.电话).toContain("+33616988559");
    expect(input.线索.国家).toBe("法国");
    if (r.ok) expect(r.answer.research.目标).toMatchObject({ name: "ISHA.A SAS", 联系人: "ZEESHAN AFZAL", customerId: 那位.id });
  });

  it("没填公司、有电话：不拿人名当公司查，要先找公司（没开跑、没扣）", async () => {
    h.客户 = { ...structuredClone(那位), school: null };
    const r = await 跑({ company: "ZEESHAN AFZAL", customerId: 那位.id });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("没扣次数") });
    expect(h.跑背调).not.toHaveBeenCalled(); // 扣次在 跑背调 里（research/start），没走到就没扣
  });

  it("没公司：找公司点选了候选，同一个 runId 接着背调那家", async () => {
    h.客户 = { ...structuredClone(那位), school: null };
    const pick = { name: "ZEESHAN AFZAL", phone: "+33616988559", 候选: { 公司: "Isha A SAS", 依据: "名录页", 来源: { title: "名录", url: "https://example.fr/isha" } }, 出现: {}, 证据: [] };
    const r = await 跑({ company: "Isha A SAS", customerId: 那位.id, runId: "run_1", pick });
    expect(r.ok).toBe(true);
    expect(h.跑背调.mock.calls[0][0]).toMatchObject({ 公司: "Isha A SAS", runId: "run_1" });
  });

  it("没公司走找公司：照首页那条路（person），不带客户 id 也能跑", async () => {
    h.找公司.mockResolvedValue({ ok: true, 候选: [], runId: "run_2", 材料: [] });
    const r = await 跑({ person: { name: "ZEESHAN AFZAL", phone: "+33616988559" } });
    expect(r.ok).toBe(true);
    expect(h.找公司).toHaveBeenCalledWith(expect.objectContaining({ 名: "ZEESHAN AFZAL", 电话: "+33616988559" }));
    expect(h.跑背调).not.toHaveBeenCalled();
  });

  it("公司、官网、国际号码都没有：不跑、不扣，说清补哪样", async () => {
    h.客户 = { ...structuredClone(那位), school: null, phone: "0616988559", extra: { country: "法国", email: null, whatsapp: null, website: null } };
    const r = await 跑({ company: "ZEESHAN AFZAL", customerId: 那位.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/没填公司、官网.*没扣次数/);
    expect(h.跑背调).not.toHaveBeenCalled(); // 扣次在 跑背调 里（research/start），没走到就没扣
  });
});

describe("客户背调对象 / 对象说明（按钮提示和开跑那一下写的字）", () => {
  const 档 = { name: "ZEESHAN AFZAL", company: "ISHA.A SAS", country: "法国", phone: "+33616988559", whatsapp: "+33616988559" };

  it("有公司：背调 ISHA.A SAS（法国）· 联系人 ZEESHAN AFZAL", () => {
    const o = 客户背调对象(档, "公司");
    expect(o).toEqual({ 种类: "公司", 公司: "ISHA.A SAS", 联系人: "ZEESHAN AFZAL", 国家: "法国" });
    expect(对象说明(o)).toBe("背调 ISHA.A SAS（法国）· 联系人 ZEESHAN AFZAL");
  });

  it("客户名就是公司名：不重复写联系人", () => {
    expect(客户背调对象({ ...档, name: "isha.a  sas" }, "公司")).toEqual({ 种类: "公司", 公司: "ISHA.A SAS", 国家: "法国" });
  });

  it("没公司有官网：查官网那家", () => {
    expect(客户背调对象({ ...档, company: "", website: "https://www.isha-sas.fr/contact" }, "公司")).toMatchObject({ 种类: "公司", 公司: "isha-sas.fr", 联系人: "ZEESHAN AFZAL" });
  });

  it("没公司没官网、有国际号码：先找公司，WhatsApp 优先", () => {
    const o = 客户背调对象({ ...档, company: null, phone: "+33 1 23 45 67 89" }, "公司");
    expect(o).toEqual({ 种类: "找人", 名: "ZEESHAN AFZAL", 电话: "+33616988559", 国家: "法国" });
    expect(对象说明(o)).toContain("先按 ZEESHAN AFZAL 和 +33616988559 找他在哪家公司");
  });

  it("号码没带国家码、也没别的：不够，不扣", () => {
    expect(客户背调对象({ name: "ZEESHAN AFZAL", phone: "0616988559" }, "公司")).toMatchObject({ 种类: "不够" });
  });

  it("教培模版那一栏叫「院校」：不当公司", () => {
    expect(客户背调对象({ ...档, company: "北京大学" }, "院校")).toMatchObject({ 种类: "找人" });
  });
});
