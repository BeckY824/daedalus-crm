/**
 * 扫名片（2026-10-19）：字段拆分 + 填表规则。识别那一步要浏览器（e2e/card-scan.spec.ts 真跑），
 * 这里用实测时 PP-OCRv6 tiny 在样例名片上认出来的框（tests/fixtures/card-scan，演示数据，不是真名片）直接喂拆字段。
 */
import { describe, expect, it } from "vitest";
import { 拆字段, type 框 } from "@/lib/card-scan/parse";
import { 名片转表单, 只补空格, 空名片表单, 国家名, 带译文 } from "@/lib/card-scan/form";
import { 该换的语言 } from "@/lib/card-scan/ocr";
import * as 手机 from "@/lib/mobile/sync";
import 二十张 from "./fixtures/card-scan/v6tiny-20张.json";
import 多语言 from "./fixtures/card-scan/多语言-中英第一遍.json";
import 新增 from "./fixtures/card-scan/新增样例-最终框.json";

type 样 = { id: string; truth: { name?: string[]; company?: string[]; email?: string; phones?: string[]; country?: string } | null; 框们: 框[] };
const 拿 = (组: 样[], id: string) => 组.find((x) => x.id === id)!;

describe("拆字段：20 张样例（v6 tiny 实测输出）", () => {
  const 组 = 二十张 as unknown as 样[];
  const 对 = (x: 样) => {
    const f = 拆字段(x.框们), t = x.truth!;
    return {
      名: !t.name?.length || t.name.includes(f.name ?? ""),
      司: !t.company?.length || t.company.includes(f.company ?? ""),
      邮: !t.email || f.email === t.email,
      电: !t.phones?.length || t.phones.every((p) => f.phones.some((q) => q.e164 === p)),
      国: !t.country || f.country === t.country,
    };
  };
  it("名字、公司、邮箱、电话、国家：20 张里至少 18 张五样全对（实测 19 张）", () => {
    const 全对 = 组.filter((x) => Object.values(对(x)).every(Boolean));
    expect(全对.length).toBeGreaterThanOrEqual(18);
  });
  it("邮箱 20 张全对（填表最容易错、最要紧的一格）", () => {
    expect(组.filter((x) => !对(x).邮).map((x) => x.id)).toEqual([]);
  });
});

describe("填表", () => {
  const 英 = 拆字段(拿(二十张 as unknown as 样[], "02-en-uk").框们);
  it("和电脑上新建客户同一套格子：姓名放人、公司 / 职位各一格；电话手机优先，座机进备注；国家用表单里的叫法", () => {
    const { 填, 名字候选, 公司候选 } = 名片转表单(英, true);
    expect(填.name).toBe("Oliver Bennett");
    expect(填.school).toBe("Harbourline Lighting Ltd");
    expect(填.grade).toBe("Purchasing Manager");
    expect(填.major).toBe("");
    expect(填.phone).toBe("+447700900123");
    expect(填.email).toBe("oliver.bennett@harbourline.co.uk");
    expect(填.country).toBe("英国");
    expect(填.remark).toContain("座机：+442079460321");
    expect(填.remark).not.toMatch(/联系人|Purchasing Manager|Harbourline Lighting Ltd/);
    expect([...名字候选, ...公司候选]).toEqual([]);
  });
  it("通用模版：公司 / 职位照样各一格；邮箱、官网这些表单没有的格子都进备注，不丢", () => {
    const { 填 } = 名片转表单(英, false);
    expect(填.name).toBe("Oliver Bennett");
    expect(填.school).toBe("Harbourline Lighting Ltd");
    expect(填.email).toBe("");
    expect(填.remark).toMatch(/邮箱：oliver\.bennett@harbourline\.co\.uk/);
  });
  it("档案字段不叫公司的（教培模版院校 / 年级）：公司、职位不往里填，进备注", () => {
    const { 填 } = 名片转表单(英, false, null, false);
    expect([填.school, 填.grade]).toEqual(["", ""]);
    expect(填.remark).toContain("公司：Harbourline Lighting Ltd · 职位：Purchasing Manager");
  });
  it("没有人名的名片：姓名放公司（电脑上姓名必填）", () => {
    const { 填 } = 名片转表单({ ...英, name: null, nameAlt: [] }, true);
    expect(填.name).toBe("Harbourline Lighting Ltd");
    expect(填.school).toBe("Harbourline Lighting Ltd");
  });
  it("AI 附加：外文写成「中文（原文）」、行业进行业格、地址带中文、名片上的其他人进备注", () => {
    const f = { ...英, name: "이서준", company: "해담식품", title: "대리", address: "부산시 해운대구 센텀로 12" };
    const { 填 } = 名片转表单(f, true, { 行业: "制造业", 译: { 公司: "海潭食品", 名字: "李瑞俊", 职位: "代理", 地址: "釜山市海云台区Centum路 12" }, 别的联系人: ["김철수（과장）"] });
    expect(填.name).toBe("李瑞俊（이서준）");
    expect(填.school).toBe("海潭食品（해담식품）");
    expect(填.grade).toBe("代理（대리）");
    expect(填.major).toBe("制造业");
    expect(填.remark).toContain("地址：부산시 해운대구 센텀로 12\n（中文：釜山市海云台区Centum路 12）");
    expect(填.remark).toContain("其他联系人：김철수（과장）");
  });
  it("译文和原文一样（模型抄了一遍）只留原文", () => {
    expect(带译文("Oliver Bennett", "Oliver Bennett")).toBe("Oliver Bennett");
    expect(带译文("Acme Ltd", "")).toBe("Acme Ltd");
  });
  it("名片上没写 WhatsApp：不自动填，给「用手机号」", () => {
    const r = 名片转表单(英, true);
    expect(r.填.whatsapp).toBe("");
    expect(r.whatsapp建议).toBe("+447700900123");
  });
  it("拿不准的格子标黄：OCR 置信度低的那一格", () => {
    const f = { ...英, 待核: ["email", "phones"] };
    expect(名片转表单(f, true).黄.sort()).toEqual(["email", "phone"]);
  });
  it("次入口只补空格：手填的名字不被覆盖，备注接在后面", () => {
    const 原 = { ...空名片表单(), name: "王总", remark: "展会上聊过价格" };
    const { 填, 补了 } = 只补空格(原, 名片转表单(英, true).填);
    expect(填.name).toBe("王总");
    expect(填.phone).toBe("+447700900123");
    expect(填.remark.startsWith("展会上聊过价格\n")).toBe(true);
    expect(补了).not.toContain("name");
  });
  it("国家：ISO 两位 → 和国家候选同一个叫法", () => {
    expect(国家名("AE")).toBe("阿联酋");
    expect(国家名("hk")).toBe("中国香港");
    expect(国家名("")).toBe("");
  });
});

describe("自动换语言（汇总 7.3）", () => {
  const 组 = 多语言 as unknown as 样[];
  it("韩文名片中英认成乱码 → 换韩文；俄文 → 西里尔；中英名片不换", () => {
    expect(该换的语言(拿(组, "m01-kr-local").框们)).toBe("韩");
    expect(该换的语言(拿(组, "m11-ru").框们)).toBe("西里尔");
    for (const x of (二十张 as unknown as 样[]).slice(0, 10)) expect(该换的语言(x.框们), x.id).toBeNull();
  });
});

describe("10-20 用户反馈：WhatsApp、换成候选、备注里的标语（新增样例，演示数据）", () => {
  const 组 = 新增 as unknown as 样[];
  const 拆 = (id: string) => 拆字段(拿(组, id).框们);
  it("号码下面单独一行「WhatsApp」：手机号进 WhatsApp 格、标黄；「whatsapp」不进备注", () => {
    for (const [id, 号] of [["n06-sa-bare-wa", "+966553217788"], ["n07-th-qr-wa", "+66812345678"]]) {
      const f = 拆(id);
      expect(f.whatsapp, id).toBe(号);
      expect(f.剩下.join(" "), id).not.toMatch(/whatsapp/i);
      const r = 名片转表单(f, true);
      expect(r.填.whatsapp, id).toBe(号);
      expect(r.黄, id).toContain("whatsapp");
    }
  });
  it("「WA +44…」「WhatsApp: +7…」：直接进 WhatsApp 格，不标黄", () => {
    expect(拆("n11-en-uk-wa").whatsapp).toBe("+447712345678");
    expect(拆("n10-ru-en").whatsapp).toBe("+79147008899");
    expect(名片转表单(拆("n11-en-uk-wa"), true).黄).not.toContain("whatsapp");
  });
  it("没写 WhatsApp 的不硬填", () => {
    for (const id of ["n01-kr-slogan", "n03-jp-kabushiki", "n12-en-us-cell", "n13-cn-slogan"]) expect(拆(id).whatsapp, id).toBeNull();
  });
  it("「换成」候选不放公司下面的小字业务说明；人名、公司各进各的格", () => {
    for (const [id, 人, 公司] of [["n12-en-us-cell", "Michael Rodriguez", "Pacific Bay Seafood, Inc."], ["n07-th-qr-wa", "Pornchai Wongsuwan", "SIAM SEA PRODUCTS CO., LTD."]]) {
      const r = 名片转表单(拆(id), true);
      expect([r.填.name, r.填.school], id).toEqual([人, 公司]);
      expect([...r.名字候选, ...r.公司候选], id).toEqual([]);
    }
  });
  it("备注里不放 logo 字、标语、创立年份、号码标签残字", () => {
    for (const x of 组)
      expect(拆字段(x.框们).剩下, x.id).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(OCEANIA|MARUSAN|HAIXIN|SIAM SEA|携带|whatsapp|WA)$/i)]));
    expect(拆("n13-cn-slogan").剩下).toEqual([]);
    expect(拆("n04-jp-en-since").剩下).toEqual([]);
    expect(拆("n09-ru-slogan").剩下).toEqual([]);
    expect(拆("n11-en-uk-wa").剩下).toEqual([]);
  });
  it("俄文公司前缀被认成 000 / 拉丁 AO 也认得是公司，还原成 ООО / АО", () => {
    expect(拆("n09-ru-slogan").company).toMatch(/^ООО\s*«Северное Море»$/);
    expect(拆("n10-ru-en").company).toBe("АО «Восток Краб»");
  });
  it("青岛「香港中路」不是香港：国家看邮箱 .cn", () => {
    expect(拆("n13-cn-slogan").country).toBe("CN");
  });
  it("泰文「จำกัด」NFKC 后拼回原样（不变成 ํ + า）", () => {
    expect(拆("n08-th-thai").company).toContain("จำกัด");
  });
});

describe("手机新建客户带上名片里多出来的", () => {
  it("外贸：微信、官网进档案，备注进客户；备注截 2000 字", async () => {
    const 库 = new 手机.内存库();
    const 状态 = 手机.新状态();
    const 钟 = { 钟: { name: "x" } };
    await 库.放({ t: "User", k: "acct_li", r: { id: "acct_li", name: "李娜" }, ...钟 });
    await 库.放({ t: "Setting", k: "business", r: { key: "business", value: JSON.stringify({ template: "trade", currency: "USD" }) }, ...钟 });
    const 机 = { teamId: "t1", device: "m_phone", key: "", epoch: 0, keys: {}, userId: "acct_li", 私钥: new Uint8Array() } as unknown as 手机.手机团队;
    const { id } = await 手机.新建客户(机, 库, 状态, { name: "Harbourline Lighting Ltd", phone: "+447700900123", wechat: "wx_ob", website: "harbourline.co.uk", remark: `联系人：Oliver Bennett\n${"x".repeat(3000)}`, source: "2026 迪拜展" });
    const 客 = (await 库.取("Customer", id))!.r;
    expect(String(客.remark).startsWith("联系人：Oliver Bennett\n")).toBe(true);
    expect(String(客.remark).length).toBe(2000);
    expect((await 库.取("CustomerExtra", id))?.r).toMatchObject({ wechat: "wx_ob", website: "harbourline.co.uk", source: "2026 迪拜展" });
  });
});
