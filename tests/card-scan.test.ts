/**
 * 扫名片（2026-10-19）：字段拆分 + 填表规则。识别那一步要浏览器（e2e/card-scan.spec.ts 真跑），
 * 这里用实测时 PP-OCRv6 tiny 在样例名片上认出来的框（tests/fixtures/card-scan，演示数据，不是真名片）直接喂拆字段。
 */
import { describe, expect, it } from "vitest";
import { 拆字段, type 框 } from "@/lib/card-scan/parse";
import { 名片转表单, 只补空格, 空名片表单, 国家名 } from "@/lib/card-scan/form";
import { 该换的语言 } from "@/lib/card-scan/ocr";
import * as 手机 from "@/lib/mobile/sync";
import 二十张 from "./fixtures/card-scan/v6tiny-20张.json";
import 多语言 from "./fixtures/card-scan/多语言-中英第一遍.json";

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
  it("外贸：名字放公司，人名 + 职位进备注；电话手机优先，座机进备注；国家用表单里的叫法", () => {
    const { 填, 名字候选 } = 名片转表单(英, true);
    expect(填.name).toBe("Harbourline Lighting Ltd");
    expect(填.phone).toBe("+447700900123");
    expect(填.email).toBe("oliver.bennett@harbourline.co.uk");
    expect(填.country).toBe("英国");
    expect(填.remark).toContain("联系人：Oliver Bennett（Purchasing Manager）");
    expect(填.remark).toContain("+442079460321");
    expect(名字候选).toContain("Oliver Bennett");
  });
  it("通用模版：名字放人名；邮箱、官网这些表单没有的格子都进备注，不丢", () => {
    const { 填 } = 名片转表单(英, false);
    expect(填.name).toBe("Oliver Bennett");
    expect(填.email).toBe("");
    expect(填.remark).toMatch(/公司：Harbourline Lighting Ltd/);
    expect(填.remark).toMatch(/邮箱：oliver\.bennett@harbourline\.co\.uk/);
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
