/**
 * 只有人名 + 电话 / WhatsApp、没有公司（lib/research/person.ts，10-18 用户 / 总控）：
 *   - 号码本机判（国家、类型），不花钱
 *   - 搜号码、搜名字；模型认出的候选**程序再核一遍**（来源得是这次的结果、里面得真有号码或名字和公司名）
 *   - 有候选：不收尾，等人点选；接着背调同一个 runId、真实性多一项「人和号码」
 *   - 没有：「只有人」简版不扣（10-19 用户：没认出公司，我们贴搜索费；收尾报 简版，服务器对过账才退），出建议；私人社交不列
 *   - 有候选、人点「都不是」：照扣（候选本身就是认出了公司），桌面端那时不收尾
 *   - 输入框那一句怎么认成「人」（target.ts）；浏览器回传的点选怎么收（stream.ts 收接着）
 */
import { describe, it, expect, vi } from "vitest";
import { 认号码, 有号码, 有名字, 是私人社交, 找公司查询, 号码写法, 核候选, 找公司, 人号项, 简版建议, type 号码信息 } from "@/lib/research/person";
import { 跑背调, type 模型调用 } from "@/lib/research/run";
import { 模拟通道, 模拟搜索 } from "@/lib/research/mock";
import { 认背调对象 } from "@/lib/research/target";
import { 收接着 } from "@/lib/research/stream";
import { 初始状态, 归约, 认背调状态 } from "@/lib/research/state";
import { 报告文本 } from "@/lib/research/report";
import type { 研究事件, 搜索结果 } from "@/lib/research/types";
import type { 背调通道 } from "@/lib/research/channel";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

const 号 = 认号码("+49 40 0000 0000") as 号码信息;

describe("认号码 / 有号码 / 有名字", () => {
  it("国家、类型、国际和本国写法", () => {
    expect(号).toMatchObject({ 号: "+49 40 00000000", 本国: "040 00000000", 本体: "4000000000", 国家: "DE", 类型: "固话", 有效: true });
    expect(认号码("+971 50 123 4567")).toMatchObject({ 国家: "AE", 类型: "手机", 本体: "501234567" });
    expect(认号码("12345")).toBeNull();
    expect(认号码("+44 7700 900123")).toMatchObject({ 有效: false });
  });

  it("各种写法都认得出同一个号码；短号不认", () => {
    expect(有号码("Tel. +49 (0)40 0000-0000", 号)).toBe(true);
    expect(有号码("Telefon: 040 0000 0000", 号)).toBe(true);
    expect(有号码("https://wa.me/494000000000", 号)).toBe(true);
    expect(有号码("+49 40 1111 2222", 号)).toBe(false);
    expect(有号码("0000", { ...号, 本体: "0000" })).toBe(false);
  });

  it("名字的每个词都在才算；去掉重音", () => {
    expect(有名字("Anna Beispiel - Einkauf - Lumora", "Anna Beispiel")).toBe(true);
    expect(有名字("José Pérez, ventas", "Jose Perez")).toBe(true);
    expect(有名字("Anna Schmidt", "Anna Beispiel")).toBe(false);
    expect(有名字("anything", undefined)).toBe(false);
  });

  it("私人社交不列：Instagram、TikTok、X、Facebook 个人页 / 群组；Facebook 公司页、LinkedIn 列", () => {
    for (const u of ["https://www.instagram.com/p/x", "https://tiktok.com/@a", "https://x.com/a", "https://www.facebook.com/profile.php?id=1", "https://facebook.com/groups/abc", "not a url"]) expect(是私人社交(u)).toBe(true);
    for (const u of ["https://www.facebook.com/LumoraTrading", "https://www.linkedin.com/in/anna", "https://directory.example/x"]) expect(是私人社交(u)).toBe(false);
  });

  it("搜什么：国际（带 (0)）、本国（连写）各 OR 在一次里，不带开头 0 的一串，再加「名字 + 英文国名」，最多 4 次", () => {
    expect(找公司查询("Anna Beispiel", 号)).toEqual(['"+49 40 00000000" OR "+49 (0)40 00000000"', '"040 00000000" OR "04000000000"', "40 00000000", '"Anna Beispiel" Germany']);
    expect(找公司查询(undefined, 号)).toEqual(['"+49 40 00000000" OR "+49 (0)40 00000000"', '"040 00000000" OR "04000000000"', "40 00000000"]);
    // 10-18 复核：sunrgy.co.uk 上写的是「0114 327 1314」
    const 英 = 认号码("+44 114 327 1314") as 号码信息;
    expect(号码写法(英)).toEqual({ 国际: ["+44 114 327 1314", "+44 (0)114 327 1314"], 本国: ["0114 327 1314", "01143271314"], 去零: "114 327 1314" });
    expect(找公司查询(undefined, 英)).toEqual(['"+44 114 327 1314" OR "+44 (0)114 327 1314"', '"0114 327 1314" OR "01143271314"', "114 327 1314"]);
    // 本国写法不带 0 的（美国）：没有 (0) 那种、也没有「去零」那一次
    const 美 = 认号码("+1 212 736 3100") as 号码信息;
    expect(找公司查询(undefined, 美)).toEqual(['"+1 212 736 3100"', '"(212) 736-3100" OR "2127363100"']);
  });

  it("虚构号码（Ofcom 影视剧号段）：认得出；不搜号码，只搜名字；连名字都没有就一次不搜", () => {
    const 假 = 认号码("+44 20 7946 0123") as 号码信息;
    expect(假.虚构).toContain("伦敦 020 7946 0xxx");
    expect(号.虚构).toBeUndefined();
    expect(找公司查询("Anna Beispiel", 假)).toEqual(['"Anna Beispiel" United Kingdom']);
    expect(找公司查询(undefined, 假)).toEqual([]);
  });
});

describe("核候选：模型认的公司，程序再核", () => {
  const 结果: 搜索结果[] = [
    { title: "Lumora Trading GmbH — Kontakt", url: "https://directory.example/lumora", snippet: "Lumora Trading GmbH, Hamburg. Tel. +49 40 0000 0000." },
    { title: "Anna Beispiel - Einkauf - Lumora Trading GmbH | LinkedIn", url: "https://www.linkedin.com/in/anna", snippet: "Purchasing." },
    { title: "Some page", url: "https://other.example/x", snippet: "Tel. +49 40 0000 0000" },
  ];
  it("来源要是这次的结果、有号码或名字、真提到这家；号码对上的排前面；最多 4 家、去重", () => {
    const r = 核候选(
      [
        { 公司: "Lumora Trading GmbH", 职位: "Einkauf", 依据: "名字和公司一起出现", 来源: 2 },
        { 公司: "Lumora Trading GmbH", 依据: "号码在名录上", 来源: "https://directory.example/lumora" },
        { 公司: "Lumora Trading", 来源: 1 },
        { 公司: "Made Up Ltd", 来源: 3 }, // 那一条里没有这家公司
        { 公司: "Ghost GmbH", 来源: 9 }, // 编号越界
        { 公司: "X", 来源: 1 }, // 名字太短
      ],
      结果,
      "Anna Beispiel",
      号,
    );
    // 同一家从名录（号码）和 LinkedIn（名字）认出来：并成一家，来源用号码那条，职位留着
    expect(r).toEqual([{ 公司: "Lumora Trading GmbH", 职位: "Einkauf", 依据: "号码在名录上", 来源: { title: "Lumora Trading GmbH — Kontakt", url: "https://directory.example/lumora" }, 号码对上: true, 名字对上: true }]);
  });
  it("不是数组 / 空 → 空", () => {
    expect(核候选(null, 结果, "Anna", 号)).toEqual([]);
    expect(核候选([{}], 结果, "Anna", 号)).toEqual([]);
  });
});

/** 找公司那一步的假模型：认第一条带 Lumora 的；没有就空。别的步回空 JSON（能跑完、没结论） */
function 假模型(): 模型调用 & { 调用: string[] } {
  const 调用: string[] = [];
  return {
    调用,
    async tools(messages, _t, o) {
      调用.push(`tools:${o.researchStage}`);
      return { toolCalls: [], text: "{}" };
    },
    async json(messages, o) {
      调用.push(`json:${o.researchStage}`);
      const p = messages.map((m) => String(m.content ?? "")).join("\n");
      if (o.researchStage === "person") {
        expect(p).toContain("不写住址、家人、私人社交动态");
        const 条 = [...p.matchAll(/^\[(\d+)\] (.+)$/gm)].find((m) => /Lumora/.test(m[2]));
        return { 候选: 条 ? [{ 公司: "Lumora Trading GmbH", 官网: "https://lumora-trading.example", 依据: "号码在名录里", 来源: Number(条[1]) }] : [] };
      }
      return {};
    },
  };
}

async function 找(名: string | undefined, 电话: string, 通道: 背调通道 = 模拟通道()) {
  const 事件: 研究事件[] = [];
  const m = 假模型();
  const r = await 找公司({ 名, 电话, b: { brief: "LED 照明出口" }, 通道, 模型: m, 发: (e) => 事件.push(e), runId: "run-p" });
  return { r, 事件, m };
}

describe("找公司", () => {
  it("号码在名录上：认出 Lumora，不收尾（等人点选）；私人社交不进「出现过」", async () => {
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    const { r, 事件, m } = await 找("Anna Beispiel", "+49 40 0000 0000", 通道);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.候选.map((c) => c.公司)).toEqual(["Lumora Trading GmbH"]);
    expect(r.候选[0]).toMatchObject({ 号码对上: true, 来源: { url: "https://directory.example/lumora-trading-gmbh" } });
    expect(r.出现.号码.map((x) => x.url)).toEqual(["https://directory.example/lumora-trading-gmbh"]);
    expect(r.出现.名字.map((x) => x.url)).toEqual(["https://www.linkedin.com/in/anna-beispiel-example"]);
    expect(收尾).not.toHaveBeenCalled();
    expect(事件[0]).toMatchObject({ type: "person", 名: "Anna Beispiel" });
    expect(事件.filter((e) => e.type === "tool" && e.status === "done")).toHaveLength(4);
    expect(事件.some((e) => e.type === "done")).toBe(false);
    expect(m.调用).toEqual(["json:person"]);
    const 找到 = 事件.find((e) => e.type === "person-found");
    expect(找到 && "建议" in 找到 && 找到.建议?.length).toBeGreaterThan(1);
  });

  it("号码、名字都搜不到：不问模型，出简版、收尾报跑完 + 简版（10-19 不扣）", async () => {
    const 通道 = 模拟通道();
    const 收尾 = vi.spyOn(通道, "收尾");
    const { r, 事件, m } = await 找(undefined, "+971 50 123 4567", 通道);
    expect(r.ok && r.候选).toEqual([]);
    expect(m.调用).toEqual([]);
    expect(收尾).toHaveBeenCalledWith("run-p", true, { searches: 3, pages: 0, 简版: true });
    expect(事件.at(-1)).toMatchObject({ type: "done", 不完整: false, 退了: false });
    let s = 初始状态({ name: "+971 50 123 4567" });
    for (const e of 事件) s = 归约(s, e);
    expect(s.人?.tools).toHaveLength(3);
    expect(s.人?.出现).toEqual({ 号码: [], 名字: [] });
    const 文 = 报告文本(s);
    expect(文).toContain("只有人，没有公司");
    expect(文).toContain("信息少，谨慎");
    expect(文).toContain("阿联酋手机");
    expect(文).toContain("公开网页上没搜到这个号码");
    expect(文).toContain("只出简版这次不扣次数");
    expect(文).toContain("没有登录、没有抓取");
    // 读回来的状态认得出 人
    expect(认背调状态(JSON.parse(JSON.stringify(s)))?.人?.号.号).toBe("+971 50 123 4567");
  });

  it("只有一个虚构号码：不开始、不搜、不扣，直接出简版，建议第一条写明是虚构号码", async () => {
    const 通道 = 模拟通道();
    const 开始 = vi.spyOn(通道, "开始");
    const 搜索 = vi.spyOn(通道, "搜索");
    const 收尾 = vi.spyOn(通道, "收尾");
    const { r, 事件, m } = await 找(undefined, "+44 20 7946 0123", 通道);
    expect(r.ok && r.候选).toEqual([]);
    expect(开始).not.toHaveBeenCalled();
    expect(搜索).not.toHaveBeenCalled();
    expect(收尾).not.toHaveBeenCalled();
    expect(m.调用).toEqual([]);
    expect(事件.at(-1)).toEqual({ type: "done", charge: 0, 不完整: false });
    const 找到 = 事件.find((e) => e.type === "person-found");
    const 建议 = 找到 && "建议" in 找到 ? 找到.建议 ?? [] : [];
    expect(建议[0]).toContain("这个号码是虚构号码");
    expect(建议.join("")).toContain("这次没搜索、没扣次数");
  });

  it("虚构号码 + 名字：只搜名字；页面上出现这个号码（拿它当占位符的网站）不算认出", async () => {
    const 通道 = 模拟通道();
    const 查询们: string[] = [];
    通道.搜索 = async (_id, q) => {
      查询们.push(q);
      // Happy Sandpit 那种：联系页拿虚构号码当占位符
      return [{ title: "Happy Sandpit — Contact", url: "https://happysandpit.example/contact", snippet: "Happy Sandpit Ltd. Call us on 020 7946 0123." }];
    };
    const { r } = await 找("Anna Beispiel", "+44 20 7946 0123", 通道);
    expect(查询们).toEqual(['"Anna Beispiel" United Kingdom']);
    // 名字没出现、号码不算：没东西给模型，没有候选
    expect(r.ok && r.候选).toEqual([]);
    expect(r.ok && r.出现.号码).toEqual([]);
  });

  it("号码认不出：不开始、不扣", async () => {
    const 通道 = 模拟通道();
    const 开始 = vi.spyOn(通道, "开始");
    const { r } = await 找("Anna", "12345", 通道);
    expect(r).toEqual({ ok: false, error: "这个号码认不出来：要 + 开头、带国家码的国际号码", 退了: false });
    expect(开始).not.toHaveBeenCalled();
  });

  it("开始就被拒（次数不够）：一次都不搜", async () => {
    const 通道 = { ...模拟通道(), 开始: async () => ({ ok: false as const, error: "背调次数用完了" }) } as 背调通道;
    const 搜索 = vi.spyOn(通道, "搜索");
    expect((await 找("Anna", "+49 40 0000 0000", 通道)).r).toEqual({ ok: false, error: "背调次数用完了", 退了: false });
    expect(搜索).not.toHaveBeenCalled();
  });

  it("中途出错：收尾报没跑完，退不退听服务器", async () => {
    const 通道 = { ...模拟通道(), 收尾: async () => ({ ok: true as const, 退了: 1, 还剩: 3 }) } as 背调通道;
    const m = 假模型();
    m.json = async () => {
      throw new Error("上游模型接口超时");
    };
    const r = await 找公司({ 名: "Anna Beispiel", 电话: "+49 40 0000 0000", b: { brief: "" }, 通道, 模型: m, 发: () => {}, runId: "run-p" });
    expect(r).toEqual({ ok: false, error: "上游模型接口超时", 退了: true });
  });
});

describe("点选以后接着背调", () => {
  it("同一个 runId；认出它的那条搜索结果在材料里；真实性多一项「人和号码」（号码对上 → 绿）；报告写明从哪认出", async () => {
    const 找结果 = await 找("Anna Beispiel", "+49 40 0000 0000");
    if (!找结果.r.ok) throw new Error("找公司没成");
    const c = 找结果.r.候选[0];
    const 通道 = 模拟通道();
    const 开始 = vi.spyOn(通道, "开始");
    const 事件: 研究事件[] = [];
    const r = await 跑背调({
      公司: c.公司,
      runId: 找结果.r.runId,
      接着: { 人: { 名: "Anna Beispiel", 号 }, 候选: c, 出现: 找结果.r.出现, 证据: 找结果.r.材料.filter((x) => x.url === c.来源.url) },
      线索: { 邮箱: [], 电话: [号.号] },
      b: { brief: "LED 照明出口", fields: [] } as never,
      通道,
      模型: 假模型(),
      老客户: [],
      发: (e) => 事件.push(e),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(开始).toHaveBeenCalledWith("run-p", undefined);
    expect(r.材料.map((m) => m.url)).toContain("https://directory.example/lumora-trading-gmbh");
    const 项 = r.状态.真实性?.项.find((x) => x.key === "person");
    expect(项).toMatchObject({ 灯: "green", 态: "已核" });
    expect(项?.事实).toContain("+49 40 00000000");
    expect(项?.链接?.[0].url).toBe("https://directory.example/lumora-trading-gmbh");
    expect(r.状态.人?.选了).toBe("Lumora Trading GmbH");
    const 文 = 报告文本(r.状态);
    expect(文).toContain("【询盘人】");
    expect(文).toContain("人和号码");
  });

  it("普通背调没有「人和号码」那一行", async () => {
    const r = await 跑背调({ 公司: "Lumora Trading GmbH", b: { brief: "", fields: [] } as never, 通道: 模拟通道(), 模型: 假模型(), 老客户: [], 发: () => {} });
    expect(r.ok && r.状态.真实性?.项.some((x) => x.key === "person")).toBe(false);
  });
});

describe("人号项", () => {
  const 材 = (title: string, url: string, text: string) => ({ title, url, text });
  it("只有名字和公司一起出现 → 黄；都没有 → 黄、没查到；私人社交上的不算", () => {
    expect(人号项({ 名: "Anna Beispiel", 号 }, "Lumora Trading GmbH", "lumora-trading.example", [材("Anna Beispiel - Lumora Trading GmbH", "https://linkedin.com/in/a", "")])).toMatchObject({ 灯: "yellow", 态: "已核" });
    expect(人号项({ 名: "Anna Beispiel", 号 }, "Lumora Trading GmbH", undefined, [材("Lumora Trading GmbH", "https://instagram.com/p/1", "+49 40 0000 0000")])).toMatchObject({ 灯: "yellow", 态: "没查到" });
    // 号码在它官网上（页面里没写公司名）也算
    expect(人号项({ 号 }, "Lumora Trading GmbH", "lumora-trading.example", [材("Kontakt", "https://www.lumora-trading.example/kontakt", "Tel 040 0000 0000")])).toMatchObject({ 灯: "green" });
  });

  it("虚构号码：哪怕出现在这家公司的页面上（拿它当占位符）也亮红，写明是虚构号码", () => {
    const 假 = 认号码("+44 20 7946 0123") as 号码信息;
    const r = 人号项({ 名: "Anna Beispiel", 号: 假 }, "Happy Sandpit Ltd", "happysandpit.example", [材("Contact", "https://happysandpit.example/contact", "Call us on 020 7946 0123")]);
    expect(r).toMatchObject({ key: "person", 灯: "red", 态: "已核" });
    expect(r.事实).toContain("是虚构号码");
    expect(r.事实).toContain("伦敦 020 7946 0xxx");
  });

  it("核候选：虚构号码出现在页面上不算号码对上", () => {
    const 假 = 认号码("+44 20 7946 0123") as 号码信息;
    const 结果 = [{ title: "Happy Sandpit Ltd — Contact", url: "https://happysandpit.example/contact", snippet: "Happy Sandpit Ltd. Call us on 020 7946 0123." }];
    expect(核候选([{ 公司: "Happy Sandpit Ltd", 来源: 1 }], 结果, undefined, 假)).toEqual([]);
  });
});

describe("简版建议", () => {
  it("固定几条；虚拟号段多一条；全没搜到的写先别发货；扣没扣按情形写", () => {
    const a = 简版建议(号, { 号码: [], 名字: [] });
    expect(a[0]).toContain("公司全名和官网");
    expect(a[0]).toContain("只出简版这次不扣次数");
    expect(简版建议(号, { 号码: [], 名字: [] }, "有候选")[0]).toContain("这次已经扣过");
    expect(简版建议(号, { 号码: [], 名字: [] }, "没搜")[0]).toContain("没扣次数");
    expect(a.join()).toContain("别先发货");
    expect(简版建议({ ...号, 类型: "网络电话（虚拟号段）" }, { 号码: [{ title: "x", url: "https://x.example" }], 名字: [] }).join()).toContain("虚拟号段");
  });
});

describe("输入框那一句：认成「人」", () => {
  it.each([
    ["Ahmed Khan +971 50 123 4567", { 种类: "人", 名: "Ahmed Khan", 电话: "+971 50 123 4567" }],
    ["+971501234567", { 种类: "人", 电话: "+971501234567" }],
    ["客户叫 Ahmed，WhatsApp +971 50 123 4567", { 种类: "人", 名: "Ahmed", 电话: "+971 50 123 4567" }],
    ["只有名字 Mohammed Ali 和电话 +966 50 123 4567", { 种类: "人", 名: "Mohammed Ali", 电话: "+966 50 123 4567" }],
    ["查一下 +44 114 496 0000 这个号码", { 种类: "人", 电话: "+44 114 496 0000" }],
  ])("%s", (输入, 期望) => {
    expect(认背调对象(输入)).toEqual(期望);
  });
  it("有公司后缀 / 邮箱 / 网址的不算人：按公司背调，号码不进公司名", () => {
    expect(认背调对象("Lumora Trading GmbH +49 40 0000 0000")).toEqual({ 种类: "公司", 公司: "Lumora Trading GmbH" });
    expect(认背调对象("Anna anna@lumora.example +49 40 0000 0000").种类).not.toBe("人");
    expect(认背调对象("lumora-trading.example +49 40 0000 0000")).toEqual({ 种类: "公司", 公司: "lumora-trading.example" });
    expect(认背调对象("帮我查 Rexel")).toEqual({ 种类: "公司", 公司: "Rexel" });
  });
});

describe("收接着（浏览器回传的点选）", () => {
  it("形状对才收；来源必须是 http(s)；证据最多 4 条", () => {
    const ok = 收接着({ name: "Anna", phone: "+49 40 0000 0000", 候选: { 公司: "Lumora Trading GmbH", 依据: "x", 来源: { title: "t", url: "https://directory.example/a" }, 号码对上: true }, 出现: { 号码: [{ title: "t", url: "https://directory.example/a" }, { url: "javascript:alert(1)" }] }, 证据: Array(6).fill({ title: "t", url: "https://directory.example/a", snippet: "s" }) });
    expect(ok).toMatchObject({ 名: "Anna", 电话: "+49 40 0000 0000", 候选: { 公司: "Lumora Trading GmbH", 号码对上: true, 名字对上: false } });
    expect(ok?.出现.号码).toHaveLength(1);
    expect(ok?.证据).toHaveLength(4);
    expect(收接着({ phone: "+49", 候选: { 公司: "Lumora", 来源: { url: "ftp://x" } } })).toBeNull();
    expect(收接着(null)).toBeNull();
  });
});

describe("模拟搜索（找人）", () => {
  it("号码带 0000000 → 名录页；别的号码 → 空；Anna Beispiel → LinkedIn", () => {
    expect(模拟搜索('"+49 40 00000000"')[0].url).toBe("https://directory.example/lumora-trading-gmbh");
    expect(模拟搜索('"+971 50 123 4567"')).toEqual([]);
    expect(模拟搜索('"Anna Beispiel" Germany')[0].url).toContain("linkedin.com/in/");
  });
});
