/**
 * 商机 / 订单的附件（2026-10-22 D-24）。
 *
 * 钉的是：
 *   - 规矩：超了说清超了多少、大小写给人看、改成 .jpg、编号挡 ../、文件名去路径
 *   - 存 / 列 / 删：文件在数据目录 attachments/<编号>，行只记名字和大小；文件不在照样列出来、标「不在这台电脑上」
 *   - 接口：传上去、取回来字节一样；这一版只收图片（别的 415）；超上限 413 且说清超了多少；库里万一有不是图片的，取的时候一律当下载；删了文件也没了
 *   - 清孤儿：商机删了先不动（能撤销），满 1 天才连文件删；没有行的文件 10 分钟后删
 *   - 导出客户：Excel 里多一列「图片张数」（不带图片）；导回来这列不收、不并进备注
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ user: { id: "", name: "QA", email: "qa-att", role: "ADMIN", title: "管理员" } as { id: string; name: string; email: string; role: string; title: string } | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => state.user, requireUser: async () => state.user }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 附件上限字节, 超限说明, 读大小, 换成jpg, 是附件编号, 规整文件名, 可以压, 要重画, 不收说明 } from "@/lib/attachment-rules";
import { 存附件, 列附件, 删附件, 附件个数, 客户附件个数, 清孤儿, 附件文件, 确保文件 } from "@/lib/attachments";
import { GET as 列, POST as 传 } from "@/app/api/attachments/route";
import { GET as 取, DELETE as 删 } from "@/app/api/attachments/[id]/route";
import { 客户导出表, 附件个数说法 } from "@/app/(app)/customers/export-table";
import { DEFAULT_BUSINESS } from "@/lib/business-config";

const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), "crm-att-"));
process.env.CRM_DATA_DIR = 目录;
const 附件夹 = path.join(目录, "attachments");

let ids: { customer: string; opp: string; order: string };
beforeEach(async () => {
  await resetDb();
  await prisma.tradeOrder.deleteMany();
  fs.rmSync(附件夹, { recursive: true, force: true });
  const u = await prisma.user.create({ data: { email: "qa-att", name: "QA", role: "ADMIN", password: "unused" } });
  state.user = { id: u.id, name: "QA", email: "qa-att", role: "ADMIN", title: "管理员" };
  const c = await prisma.customer.create({ data: { name: "QA-附件客户", phone: "", salesOwnerId: u.id } });
  const o = await prisma.opportunity.create({ data: { name: "QA-附件商机", customerId: c.id, ownerId: u.id } });
  const d = await prisma.tradeOrder.create({ data: { no: "QA-ATT-1", customerId: c.id, ownerId: u.id } });
  ids = { customer: c.id, opp: o.id, order: d.id };
});
afterAll(async () => {
  await prisma.attachment.deleteMany();
  await prisma.$disconnect();
  fs.rmSync(目录, { recursive: true, force: true });
  delete process.env.CRM_DATA_DIR;
});

const 字节 = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

describe("规矩", () => {
  it("超上限说清超了多少；没超回 null", () => {
    expect(超限说明("a.pdf", 附件上限字节)).toBeNull();
    const 话 = 超限说明("规格书.pdf", 附件上限字节 + 3 * 1024 * 1024)!;
    expect(话).toContain("「规格书.pdf」");
    expect(话).toContain("超了 3 MB");
    expect(话).toContain(`最多 ${读大小(附件上限字节)}`);
  });
  it("大小、扩展名、编号、文件名", () => {
    expect(读大小(12)).toBe("12 字节");
    expect(读大小(340 * 1024)).toBe("340 KB");
    expect(读大小(1.25 * 1024 * 1024)).toBe("1.3 MB");
    expect(读大小(2 * 1024 * 1024)).toBe("2 MB");
    expect(换成jpg("产品.webp")).toBe("产品.jpg");
    expect(换成jpg("无扩展名")).toBe("无扩展名.jpg");
    expect(是附件编号("cabc12345678")).toBe(true);
    for (const x of ["../crm.db", "a/b", "", "短", 3]) expect(是附件编号(x)).toBe(false);
    expect(规整文件名("C:\\Users\\x\\报价\u0007单.pdf")).toBe("报价单.pdf");
    expect(规整文件名("   ")).toBe("附件");
    expect(可以压("image/gif")).toBe(false);
    expect(可以压("image/png")).toBe(true);
  });

  it("哪些图要重画：超长边都要；JPEG / WebP / BMP 不超也要（去掉 EXIF 里的拍摄地点）；小 PNG、GIF 原样", () => {
    expect(要重画("image/png", 3000, 1500)).toBe(true);
    expect(要重画("image/png", 1200, 800)).toBe(false);
    expect(要重画("image/jpeg", 1200, 800)).toBe(true);
    expect(要重画("image/webp", 10, 10)).toBe(true);
    expect(要重画("image/gif", 5000, 5000)).toBe(false);
    expect(要重画("application/pdf", 5000, 5000)).toBe(false);
  });
});

describe("存 / 列 / 删", () => {
  it("文件按编号存，行记名字大小；文件不在也照样列出来", async () => {
    const a = await 存附件(prisma, { 挂在: { opportunityId: ids.opp }, name: "报价单.pdf", mime: "application/pdf", 字节: 字节("PDF!") });
    expect(fs.readFileSync(附件文件(a.id), "utf8")).toBe("PDF!");
    expect(a).toMatchObject({ name: "报价单.pdf", size: 4, 有文件: true });
    expect(await 确保文件(a.id)).toBe("有");
    fs.rmSync(附件文件(a.id));
    expect(await 确保文件(a.id)).toBe("没有");
    expect(await 列附件(prisma, { opportunityId: ids.opp })).toMatchObject([{ id: a.id, 有文件: false }]);
    await 删附件(prisma, a.id);
    expect(await 列附件(prisma, { opportunityId: ids.opp })).toEqual([]);
  });

  it("个数：按商机、订单，再按客户合起来", async () => {
    for (let i = 0; i < 2; i++) await 存附件(prisma, { 挂在: { opportunityId: ids.opp }, name: `图${i}.jpg`, mime: "image/jpeg", 字节: 字节("x") });
    await 存附件(prisma, { 挂在: { orderId: ids.order }, name: "合同.pdf", mime: "application/pdf", 字节: 字节("y") });
    const 数 = await 附件个数(prisma, { opportunityIds: [ids.opp], orderIds: [ids.order] });
    expect(数.商机.get(ids.opp)).toBe(2);
    expect(数.订单.get(ids.order)).toBe(1);
    const 按客户 = await 客户附件个数(prisma, [ids.customer, "没有这位"]);
    expect(按客户.get(ids.customer)).toEqual({ 商机: 2, 订单: 1 });
    expect(按客户.has("没有这位")).toBe(false);
    expect((await 客户附件个数(prisma, [ids.customer], false)).get(ids.customer)).toEqual({ 商机: 2, 订单: 0 });
  });
});

describe("接口", () => {
  const 传一个 = (q: string, 体: Uint8Array<ArrayBuffer>, 类型 = "image/jpeg") =>
    传(new Request(`http://x/api/attachments?${q}`, { method: "POST", body: 体, headers: { "Content-Type": 类型, "Content-Length": String(体.byteLength) } }));

  it("传上去、列出来、取回来字节一样；删了文件也没了", async () => {
    const r = await 传一个(`opportunityId=${ids.opp}&name=${encodeURIComponent("产品图.jpg")}`, 字节("规格"));
    expect(r.status).toBe(200);
    const { 附件: a } = await r.json();
    const 表 = await (await 列(new Request(`http://x/api/attachments?opportunityId=${ids.opp}`))).json();
    expect(表.附件.map((x: { name: string }) => x.name)).toEqual(["产品图.jpg"]);

    const 回 = await 取(new Request(`http://x/api/attachments/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    expect(new TextDecoder().decode(await 回.arrayBuffer())).toBe("规格");
    expect(回.headers.get("content-type")).toBe("image/jpeg");

    expect((await 删(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);
    expect(fs.existsSync(附件文件(a.id))).toBe(false);
    expect(await prisma.attachment.count()).toBe(0);
    // 再删一次当成功（两个窗口、连点）
    expect((await 删(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);
  });

  it("图片按原类型给，能在页面里显示", async () => {
    const { 附件: a } = await (await 传一个(`orderId=${ids.order}&name=a.png&w=10&h=20`, 字节("PNG"), "image/png")).json();
    expect(a).toMatchObject({ width: 10, height: 20, mime: "image/png" });
    const 回 = await 取(new Request(`http://x/api/attachments/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    expect(回.headers.get("content-type")).toBe("image/png");
    // 行在、文件不在（个人版：换了电脑恢复的库；团队版：还没下载）：404 说清楚
    fs.rmSync(附件文件(a.id));
    const 没 = await 取(new Request(`http://x/api/attachments/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    expect([没.status, await 没.text()]).toEqual([404, "文件不在这台电脑上"]);
  });

  it("这一版只收图片：PDF、SVG、没写类型的都回 415，说清只收哪几种，一个字节都不落", async () => {
    for (const [名, 类型] of [["规格书.pdf", "application/pdf"], ["logo.svg", "image/svg+xml"], ["a.html", "text/html"], ["无类型", ""]]) {
      const r = await 传(new Request(`http://x/api/attachments?orderId=${ids.order}&name=${encodeURIComponent(名)}`, {
        method: "POST", body: 字节("x"), headers: 类型 ? { "Content-Type": 类型 } : {},
      }));
      expect(r.status, 名).toBe(415);
      expect((await r.json()).error).toBe(不收说明(名, 类型));
    }
    expect(不收说明("a.PNG", "IMAGE/PNG")).toBeNull();
    expect(不收说明("a.pdf", "application/pdf")).toContain("只收 JPG、PNG");
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("库里万一有不是图片的（以后放开别的文件、或老库），取的时候一律当下载：.html / .svg 在本站打开能跑脚本", async () => {
    const a = await 存附件(prisma, { 挂在: { orderId: ids.order }, name: "a.html", mime: "text/html", 字节: 字节("<script>") });
    const 回 = await 取(new Request(`http://x/api/attachments/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    expect(回.headers.get("content-type")).toBe("application/octet-stream");
    expect(回.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("超上限 413，说清超了多少，一个字节都不落", async () => {
    const r = await 传(new Request(`http://x/api/attachments?opportunityId=${ids.opp}&name=big.jpg`, {
      method: "POST", body: 字节("x"), headers: { "Content-Type": "image/jpeg", "Content-Length": String(附件上限字节 + 1024 * 1024) },
    }));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toContain("超了 1 MB");
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("没登录 401；商机不在 404；参数不对 400；空文件 400", async () => {
    expect((await 传一个(`opportunityId=nothere0001&name=a.pdf`, 字节("x"))).status).toBe(404);
    expect((await 传一个(`opportunityId=${ids.opp}&orderId=${ids.order}`, 字节("x"))).status).toBe(400);
    expect((await 传一个(`opportunityId=${ids.opp}&name=a.pdf`, new Uint8Array())).status).toBe(400);
    state.user = null;
    expect((await 列(new Request(`http://x/api/attachments?opportunityId=${ids.opp}`))).status).toBe(401);
  });
});

describe("清孤儿", () => {
  it("商机删了先不动，满 1 天才连文件删；没有行的文件 10 分钟后删", async () => {
    const a = await 存附件(prisma, { 挂在: { opportunityId: ids.opp }, name: "a.pdf", mime: "application/pdf", 字节: 字节("x") });
    await prisma.opportunity.delete({ where: { id: ids.opp } });
    const 现在 = Date.now();
    expect(await 清孤儿(prisma, 附件夹, 现在, true)).toEqual({ 删行: 0, 删文件: 0 });
    expect(fs.existsSync(附件文件(a.id))).toBe(true);
    expect((await 清孤儿(prisma, 附件夹, 现在 + 25 * 3600 * 1000, true)).删行).toBe(1);
    expect(fs.existsSync(附件文件(a.id))).toBe(false);

    const 野 = path.join(附件夹, "cwild0000000");
    fs.writeFileSync(野, "x");
    expect((await 清孤儿(prisma, 附件夹, Date.now(), true)).删文件).toBe(0);
    expect((await 清孤儿(prisma, 附件夹, Date.now() + 11 * 60 * 1000, true)).删文件).toBe(1);
    expect(fs.existsSync(野)).toBe(false);
  });
});

describe("导出客户", () => {
  const 行 = { name: "张三", phone: "1", school: null, major: null, grade: null, followStatus: "", decisionStatus: "", expectedSignAt: null, signedAmount: 0, salesOwnerName: "QA", remark: "老客户" };
  it("多一列「图片张数」，在备注前面；没有图片写空", () => {
    expect(附件个数说法({ 商机: 2, 订单: 1 })).toBe("商机 2 张、订单 1 张");
    expect(附件个数说法({ 商机: 0, 订单: 3 })).toBe("订单 3 张");
    expect(附件个数说法({ 商机: 0, 订单: 0 })).toBe("");
    expect(附件个数说法(null)).toBe("");
    const t = 客户导出表([{ ...行, 附件数: { 商机: 2, 订单: 0 } }, 行], DEFAULT_BUSINESS);
    const i = t.head.indexOf("图片张数");
    expect(t.head.slice(i)).toEqual(["图片张数", "备注"]);
    expect(t.body[0][i]).toBe("商机 2 张");
    expect(t.body[1][i]).toBe("");
    expect(t.body[0][i + 1]).toBe("老客户");
  });
});
