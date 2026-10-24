/**
 * 手机端只读看团队的产品图片（2026-10-22 D-24，lib/mobile/attach.ts + crypto-web 拆附件 + view 的 图片）：
 * 桌面端 封附件 的密文手机解得开、核得过 sha256；换了编号 / 团队、内容被换都不显示；
 * 云端各种回话（还在上传、看不到、没有、断网）都说成人话；客户详情只列这位客户商机、订单上的图片。
 * 云端的权限、续传在 tests/sync-attach.test.ts 里用真实客户端测过，这里不重复。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { 封附件, 新钥匙 } from "@/lib/sync/crypto";
import * as 密 from "@/lib/sync/crypto-web";
import { 取图片, type 字节传输 } from "@/lib/mobile/attach";
import { 分表, 客户们 } from "@/lib/mobile/view";
import type { 手机团队, 记录 } from "@/lib/mobile/sync";

const 图 = Buffer.from("\xff\xd8\xff\xe0 假装是一张 JPEG 产品图 ".repeat(200), "latin1");
const sha = createHash("sha256").update(图).digest("hex");
const 老钥匙 = 新钥匙(), 新 = 新钥匙();
const 团队 = { teamId: "team_1", device: "dev_phone", key: 新, epoch: 2, keys: { "1": 老钥匙 }, userId: "acct_li" } as unknown as 手机团队;

/** 假云端：记下请求路径，按 回 返回 */
function 云(回: (路径: string) => Awaited<ReturnType<字节传输>>) {
  const 路径们: string[] = [];
  const f: 字节传输 = async (p) => { 路径们.push(p); return 回(p); };
  return { f, 路径们 };
}

describe("密文：桌面端封、手机解", () => {
  it("当前钥匙、老钥匙（换钥匙前传的图）都解得开，字节一样", async () => {
    for (const [k, 编号] of [[新, 2], [老钥匙, 1]] as const) {
      const 封好 = 封附件(图, k, 编号, { teamId: "team_1", id: "a1", sha256: sha });
      const 明 = await 密.拆附件(new Uint8Array(封好), { ...团队.keys, "2": 新 }, { teamId: "team_1", id: "a1", sha256: sha });
      expect(Buffer.from(明).equals(图)).toBe(true);
    }
    expect(await 密.字节sha256(new Uint8Array(图))).toBe(sha);
  });

  it("换了编号、换了团队、说的 sha256 不对，都解不开", async () => {
    const 封好 = new Uint8Array(封附件(图, 新, 2, { teamId: "team_1", id: "a1", sha256: sha }));
    await expect(密.拆附件(封好, 新, { teamId: "team_1", id: "a2", sha256: sha })).rejects.toThrow();
    await expect(密.拆附件(封好, 新, { teamId: "team_2", id: "a1", sha256: sha })).rejects.toThrow();
    await expect(密.拆附件(封好, 新, { teamId: "team_1", id: "a1", sha256: "0".repeat(64) })).rejects.toThrow();
    await expect(密.拆附件(封好.subarray(0, 20), 新, { teamId: "team_1", id: "a1", sha256: sha })).rejects.toThrow("版本不对");
    await expect(密.拆附件(封好, { "1": 老钥匙 }, { teamId: "team_1", id: "a1", sha256: sha })).rejects.toThrow("没有 2 号钥匙");
  });
});

describe("取图片", () => {
  it("取到密文 → 解开 → 核过 sha256 才给；请求带团队、编号、这台手机", async () => {
    const c = 云(() => ({ 状态: 200, 字节: new Uint8Array(封附件(图, 新, 2, { teamId: "team_1", id: "a1", sha256: sha })), json: {} }));
    const r = await 取图片(团队, c.f, { id: "a1", sha256: sha });
    expect(r.状态).toBe("有");
    expect(r.状态 === "有" && Buffer.from(r.字节).equals(图)).toBe(true);
    expect(c.路径们).toEqual(["/api/sync/attach?teamId=team_1&id=a1&device=dev_phone"]);
  });

  it("行里记的 sha256 和图对不上（密文是另一张图的）：不显示", async () => {
    const 别的 = Buffer.from("另一张图");
    const 别的sha = createHash("sha256").update(别的).digest("hex");
    // 拿 a1 的 sha 封了另一张图：AAD 对得上、解得开，但核 sha256 不过
    const 冒充 = 封附件(别的, 新, 2, { teamId: "team_1", id: "a1", sha256: sha });
    const r = await 取图片(团队, 云(() => ({ 状态: 200, 字节: new Uint8Array(冒充), json: {} })).f, { id: "a1", sha256: sha });
    expect(r).toEqual({ 状态: "没有", 原因: "这张图和记录对不上，没显示" });
    // 按另一张图自己的 sha 封的：AAD 对不上，解不开
    const r2 = await 取图片(团队, 云(() => ({ 状态: 200, 字节: new Uint8Array(封附件(别的, 新, 2, { teamId: "team_1", id: "a1", sha256: 别的sha })), json: {} })).f, { id: "a1", sha256: sha });
    expect(r2.状态).toBe("没有");
  });

  it("云端的各种回话都说成人话", async () => {
    const 问 = (状态: number, json: Record<string, unknown> = {}) => 取图片(团队, 云(() => ({ 状态, json })).f, { id: "a1", sha256: sha });
    expect(await 问(404, { uploading: true, error: "还在上传" })).toEqual({ 状态: "还在上传" });
    expect(await 问(404)).toMatchObject({ 状态: "没有", 原因: expect.stringContaining("传图的电脑同步一次") });
    expect(await 问(403)).toMatchObject({ 状态: "没有", 原因: expect.stringContaining("看不到") });
    expect(await 问(0, { error: "连不上网络" })).toMatchObject({ 状态: "没有", 原因: expect.stringContaining("连不上网络") });
    expect(await 问(503, { error: "图片通道暂不可用，请稍后重试" })).toEqual({ 状态: "没有", 原因: "图片通道暂不可用，请稍后重试" });
    expect(await 问(500)).toEqual({ 状态: "没有", 原因: "取不到这张图（500）" });
    // 200 但钥匙不对（团队刚换钥匙、手机还没同步到）
    const 错钥匙 = 封附件(图, 新钥匙(), 3, { teamId: "team_1", id: "a1", sha256: sha });
    expect(await 取图片(团队, 云(() => ({ 状态: 200, 字节: new Uint8Array(错钥匙), json: {} })).f, { id: "a1", sha256: sha }))
      .toMatchObject({ 状态: "没有", 原因: expect.stringContaining("先下拉同步") });
  });
});

describe("客户详情的产品图片", () => {
  const 行 = (t: string, r: Record<string, unknown>): 记录 => ({ t, k: String(r.id), r, 钟: {} });
  const 数据 = [
    行("Customer", { id: "c1", name: "Atlas", salesOwnerId: "acct_li" }),
    行("Customer", { id: "c2", name: "Nordlicht", salesOwnerId: "acct_li" }),
    行("Opportunity", { id: "o1", customerId: "c1", name: "春季", status: "OPEN" }),
    行("Opportunity", { id: "o2", customerId: "c2", name: "别家的", status: "OPEN" }),
    行("TradeOrder", { id: "t1", customerId: "c1", no: "PI-001" }),
    行("Attachment", { id: "a1", opportunityId: "o1", name: "样品.jpg", mime: "image/jpeg", size: 1200, sha256: "s1", createdAt: 1000 }),
    行("Attachment", { id: "a2", orderId: "t1", name: "包装.png", mime: "image/png", size: 800, sha256: "s2", createdAt: 2000 }),
    行("Attachment", { id: "a3", opportunityId: "o1", name: "合同.pdf", mime: "application/pdf", size: 10, sha256: "s3", createdAt: 3000 }),
    行("Attachment", { id: "a4", opportunityId: "o2", name: "别家.jpg", mime: "image/jpeg", size: 10, sha256: "s4", createdAt: 4000 }),
    // 商机还没同步到（或看不到）：挂不上客户，不列
    行("Attachment", { id: "a5", opportunityId: "o9", name: "孤儿.jpg", mime: "image/jpeg", size: 10, sha256: "s5", createdAt: 5000 }),
  ];
  const 视图 = 客户们(分表(数据), "acct_li", new Set());

  it("只列这位客户商机、订单上的图片，新传的在前，带上挂在哪", () => {
    const c1 = 视图.find((c) => c.id === "c1")!;
    expect(c1.图片.map((x) => [x.id, x.关联])).toEqual([["a2", "订单 PI-001"], ["a1", "春季"]]);
    expect(c1.图片[1]).toMatchObject({ name: "样品.jpg", mime: "image/jpeg", size: 1200, sha256: "s1" });
    expect(视图.find((c) => c.id === "c2")!.图片.map((x) => x.id)).toEqual(["a4"]);
  });
});
