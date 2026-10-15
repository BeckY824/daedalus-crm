/**
 * 手机端（浏览器版加密 crypto-web.ts）和桌面端（crypto.ts）必须一个字节都不差地互通：
 * 两个方向各验一遍——桌面端封的手机解得开、手机封的桌面端解得开；绑定对不上、签名不对时两边都拒。
 * 手机端方案：~/Opensource_CRM/02-开发与发版/手机端-方案-20261015.md 第 3 节。
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import * as 桌面 from "@/lib/sync/crypto";
import * as 手机 from "@/lib/sync/crypto-web";
import type { 改动 } from "@/lib/sync/local";

const 一条: 改动 = { t: "FollowUp", k: "fu_1", o: "I", r: { id: "fu_1", customerId: "c_1", content: "样品周一到仓，客户说「好」🙂", ownerId: "u_1" }, c: ["id", "customerId", "content", "ownerId"], h: "1760500000000-dev_phone" };
const meta = { t: "FollowUp", k: "fu_1", o: "I", h: 一条.h, fields: { customerId: "c_1", opportunityId: null, contactId: null } };
const 绑 = { teamId: "team_1", device: "dev_phone", eventId: "evt_1", meta };

describe("范围包（v4）两个方向互通", () => {
  it("桌面端封的，手机解得开", async () => {
    const k = 桌面.新钥匙();
    const 包 = 桌面.封范围({ meta, change: 一条 }, k, 2, 绑);
    expect(await 手机.拆范围<{ change: 改动 }>(包, { "2": k }, 绑)).toEqual({ meta, change: 一条 });
  });
  it("手机封的，桌面端解得开", async () => {
    const k = 桌面.新钥匙();
    const 包 = await 手机.封范围({ meta, change: 一条 }, k, 0, 绑);
    expect(桌面.包的编号(包)).toBe(0);
    expect(桌面.拆范围(包, k, 绑)).toEqual({ meta, change: 一条 });
  });
  it("外层元数据被改过（中转动了归属），两边都解不开", async () => {
    const k = 桌面.新钥匙();
    const 改过 = { ...绑, meta: { ...meta, fields: { ...meta.fields, customerId: "c_2" } } };
    await expect(手机.拆范围(桌面.封范围({ meta, change: 一条 }, k, 0, 绑), k, 改过)).rejects.toThrow();
    const 手机包 = await 手机.封范围({ meta, change: 一条 }, k, 0, 绑);
    expect(() => 桌面.拆范围(手机包, k, { ...绑, device: "dev_other" })).toThrow();
  });
  it("钥匙环里没有那一号钥匙，说清楚", async () => {
    const 包 = 桌面.封范围({ meta, change: 一条 }, 桌面.新钥匙(), 5, 绑);
    await expect(手机.拆范围(包, { "0": 桌面.新钥匙() }, 绑)).rejects.toThrow("没有 5 号钥匙");
  });
});

describe("钥匙环（版本 3）", () => {
  it("桌面端封的钥匙环，手机按团队绑定解得开；换个团队解不开", async () => {
    const k = 桌面.新钥匙();
    const 环 = { keys: { "0": 桌面.新钥匙(), "1": 桌面.新钥匙() } };
    const 封好 = 桌面.封(环, k, 0, { teamId: "team_1", device: "ring" });
    expect(await 手机.拆(封好, k, { teamId: "team_1", device: "ring" })).toEqual(环);
    await expect(手机.拆(封好, k, { teamId: "team_2", device: "ring" })).rejects.toThrow();
  });
  it("手机封的版本 3，桌面端解得开", async () => {
    const k = 桌面.新钥匙();
    const 封好 = await 手机.封({ a: 1 }, k, 3, { teamId: "t", device: "d" });
    expect(桌面.拆(封好, { "3": k }, { teamId: "t", device: "d" })).toEqual({ a: 1 });
  });
});

describe("封给 / 拆自：电脑授权时把团队钥匙封给这台手机", () => {
  it("桌面端用手机的公钥封，手机用不可导出的私钥解", async () => {
    const 手机钥 = await 手机.设备钥匙对();
    expect(桌面.是设备公钥(手机钥.公钥)).toBe(true);
    const 明文 = JSON.stringify({ teamId: "team_1", key: 桌面.新钥匙() });
    expect(await 手机.拆自(手机钥.私钥, 桌面.封给(手机钥.公钥, 明文))).toBe(明文);
  });
  it("手机封给桌面端的设备，桌面端解得开", async () => {
    const 电脑 = 桌面.设备钥匙对();
    expect(桌面.拆自(电脑.私钥, await 手机.封给(电脑.公钥, "你好，电脑"))).toBe("你好，电脑");
  });
  it("桌面端格式的私钥导进手机也能解（同一把钥匙两边算出同一个共享密钥）", async () => {
    const 电脑 = 桌面.设备钥匙对();
    const 私 = await 手机.导入设备私钥(电脑.私钥);
    expect(await 手机.拆自(私, 桌面.封给(电脑.公钥, "同一把"))).toBe("同一把");
  });
  it("封给别人的，手机解不开", async () => {
    const 别人 = 桌面.设备钥匙对();
    const 我 = await 手机.设备钥匙对();
    await expect(手机.拆自(我.私钥, 桌面.封给(别人.公钥, "不是给你的"))).rejects.toThrow();
  });
});

describe("老板签名", () => {
  it("桌面端签的手机验得过；改一个字、换用途都验不过", async () => {
    const 老板 = 桌面.签名钥匙对();
    const 签好 = 桌面.签上("环的内容", "ring|team_1|3", 老板.私钥, 老板.公钥);
    expect(await 手机.验(签好, "ring|team_1|3", 老板.公钥)).toBe("环的内容");
    expect(await 手机.验(签好.replace("环的内容", "环的内谷"), "ring|team_1|3", 老板.公钥)).toBeNull();
    expect(await 手机.验(签好, "ring|team_1|4", 老板.公钥)).toBeNull();
    expect(await 手机.验(签好, "ring|team_1|3", 桌面.签名钥匙对().公钥)).toBeNull();
  });
});

describe("事件编号", () => {
  it("和桌面端 client.ts 同一算法：同一条改动得到同一个编号", async () => {
    const k = 桌面.新钥匙();
    const 桌面算 = createHmac("sha256", Buffer.from(k, "base64url")).update(`log|dev_phone|${桌面.规范串(一条)}`).digest("hex");
    expect(await 手机.事件编号(k, "log|dev_phone", 一条)).toBe(桌面算);
    // 字段顺序不同也一样（规范串排过序）
    const 换序 = { h: 一条.h, c: 一条.c, r: 一条.r, o: 一条.o, k: 一条.k, t: 一条.t };
    expect(await 手机.事件编号(k, "log|dev_phone", 换序)).toBe(桌面算);
  });
});

describe("base64url", () => {
  it("和 Buffer 的 base64url 一致（含大块）", () => {
    const b = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(手机.转b64u(b)).toBe(Buffer.from(b).toString("base64url"));
    expect(Buffer.from(手机.解b64u(Buffer.from(b).toString("base64url")))).toEqual(Buffer.from(b));
  });
});
