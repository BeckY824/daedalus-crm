/**
 * 跨成员查重的纯规则（lib/sync/dedupe.ts）和两边算法对得上（2026-10-19）：
 * 电脑（node crypto）报上去的哈希、封的客户名，手机（WebCrypto）算出来、解得开，反过来也一样。
 * 整条链路（报 → 问 → 挡下）在 tests/team-qa-sync.test.ts F2。
 */
import { describe, expect, it } from "vitest";
import { 客户查重值, 查重键, 查重原文, 查重标签绑定, 同事撞号说法, 查重指纹 } from "@/lib/sync/dedupe";
import * as 电脑 from "@/lib/sync/crypto";
import * as 手机 from "@/lib/sync/crypto-web";

describe("规整：和本机查重同一把尺子", () => {
  it("电话按号键：空格、横杠不算；邮箱 / 微信号去空格、不分大小写", () => {
    expect(查重键("phone", " 139-0000 9100 ")).toBe(查重键("phone", "13900009100"));
    expect(查重键("email", " Anna@X.de ")).toBe("anna@x.de");
    expect(查重键("wechat", "WxID_Abc")).toBe("wxid_abc");
    expect(查重键("phone", "   ")).toBe("");
  });

  it("一位客户的几样：空的不算", () => {
    expect(客户查重值({ phone: "13900009100", email: "", wechat: null })).toEqual([{ 种: "phone", 键: 查重键("phone", "13900009100") }]);
    expect(客户查重值({ phone: "", email: "a@b.com", wechat: "wx1" }).map((x) => x.种)).toEqual(["email", "wechat"]);
  });

  it("原文带团队和种类：电话和微信号碰巧一样、不同团队，哈希都不一样", () => {
    const k = 电脑.新钥匙();
    const h = (t: string, 种: "phone" | "wechat") => 电脑.查重哈希(k, 查重原文(t, 种, "13900009100"));
    expect(h("t1", "phone")).not.toBe(h("t1", "wechat"));
    expect(h("t1", "phone")).not.toBe(h("t2", "phone"));
    expect(h("t1", "phone")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("指纹和哈希顺序无关；名字、钥匙编号变了就要重报", () => {
    expect(查重指纹(1, ["b", "a"], "x")).toBe(查重指纹(1, ["a", "b"], "x"));
    expect(查重指纹(2, ["a"], "x")).not.toBe(查重指纹(1, ["a"], "x"));
    expect(查重指纹(1, ["a"], "y")).not.toBe(查重指纹(1, ["a"], "x"));
  });

  it("那句话只有同事名 + 客户名", () => {
    expect(同事撞号说法("手机号 139", "赵业务", "某某")).toBe("手机号 139 已是同事 赵业务 名下的客户（某某），请勿重复录入；要接手请找 赵业务 或老板");
    expect(同事撞号说法("邮箱 a@b.com", "赵业务", "", "学员")).toBe("邮箱 a@b.com 已是同事 赵业务 名下的学员，请勿重复录入；要接手请找 赵业务 或老板");
  });
});

describe("电脑和手机两边对得上", () => {
  const 钥 = 电脑.新钥匙();
  const 原文 = 查重原文("team-1", "phone", 查重键("phone", "+44 7700 900123"));

  it("同一个号码，node 和 WebCrypto 算出同一个哈希；换一把钥匙就对不上", async () => {
    expect(await 手机.查重哈希(钥, 原文)).toBe(电脑.查重哈希(钥, 原文));
    expect(电脑.查重哈希(电脑.新钥匙(), 原文)).not.toBe(电脑.查重哈希(钥, 原文));
  });

  it("客户名：电脑封的手机解得开，手机封的电脑解得开；换个团队就解不开", async () => {
    const 绑 = 查重标签绑定("team-1");
    expect(await 手机.拆<string>(电脑.封("SCANDI PAK EUROPE LTD", 钥, 3, 绑), { "3": 钥 }, 绑)).toBe("SCANDI PAK EUROPE LTD");
    expect(电脑.拆<string>(await 手机.封("阿里·穆罕默德", 钥, 3, 绑), { "3": 钥 }, 绑)).toBe("阿里·穆罕默德");
    expect(() => 电脑.拆<string>(电脑.封("x", 钥, 3, 绑), { "3": 钥 }, 查重标签绑定("team-2"))).toThrow();
  });
});
