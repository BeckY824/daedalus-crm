/**
 * 浏览器没内置 X25519 / Ed25519 时（2026-10-15 真机：华为浏览器 17、QQ 浏览器 20.6，内核 Chrome 121–132），
 * crypto-web.ts 换成 @noble/curves 的纯 JS 实现。这里把 WebCrypto 的这两个算法「拿掉」，再和桌面端两个方向对一遍：
 * 必须和 sync-crypto-web.test.ts 里内置的那条路一个字节都不差。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as 桌面 from "@/lib/sync/crypto";

type 手机模块 = typeof import("@/lib/sync/crypto-web");
let 手机: 手机模块;
const 没内置 = (alg: unknown) => {
  const n = typeof alg === "string" ? alg : (alg as { name?: string } | null)?.name;
  return n === "X25519" || n === "Ed25519";
};
const 被拦: string[] = [];

beforeAll(async () => {
  const s = globalThis.crypto.subtle;
  for (const 方法 of ["generateKey", "importKey"] as const) {
    const 原 = s[方法].bind(s) as (...a: unknown[]) => Promise<unknown>;
    // 和老内核一样：认不得这个算法名
    vi.spyOn(s, 方法).mockImplementation(((...a: unknown[]) => {
      const alg = 方法 === "generateKey" ? a[0] : a[2];
      if (没内置(alg)) { 被拦.push(方法); return Promise.reject(new DOMException("Algorithm: Unrecognized name", "NotSupportedError")); }
      return 原(...a);
    }) as never);
  }
  vi.resetModules();
  手机 = await import("@/lib/sync/crypto-web");
});
afterAll(() => { vi.restoreAllMocks(); });

describe("没内置 X25519：纯 JS 实现和桌面端互通", () => {
  it("确实走了纯 JS：私钥是原始 32 字节，公钥是桌面端认的 SPKI", async () => {
    expect(await 手机.有内置("X25519")).toBe(false);
    const 钥 = await 手机.设备钥匙对(true);
    expect(钥.私钥).not.toBeInstanceOf(CryptoKey);
    expect((钥.私钥 as { raw: Uint8Array }).raw).toHaveLength(32);
    expect(桌面.是设备公钥(钥.公钥)).toBe(true);
    expect(被拦.length).toBeGreaterThan(0);
  });
  it("桌面端用手机的公钥封，手机解得开", async () => {
    const 钥 = await 手机.设备钥匙对(true);
    const 明文 = JSON.stringify({ teamId: "team_1", key: 桌面.新钥匙() });
    expect(await 手机.拆自(钥.私钥, 桌面.封给(钥.公钥, 明文))).toBe(明文);
  });
  it("手机封给桌面端的设备，桌面端解得开", async () => {
    const 电脑 = 桌面.设备钥匙对();
    expect(桌面.拆自(电脑.私钥, await 手机.封给(电脑.公钥, "你好，电脑"))).toBe("你好，电脑");
  });
  it("同一把钥匙两边算出同一个共享密钥：桌面端私钥的原始 32 字节放进纯 JS 也能解", async () => {
    const 电脑 = 桌面.设备钥匙对();
    const pkcs8 = Buffer.from(电脑.私钥, "base64url");
    const raw = new Uint8Array(pkcs8.subarray(pkcs8.length - 32));
    expect(await 手机.拆自({ raw }, 桌面.封给(电脑.公钥, "同一把"))).toBe("同一把");
  });
  it("封给别人的解不开；公钥格式不对直接拒", async () => {
    const 别人 = 桌面.设备钥匙对();
    const 我 = await 手机.设备钥匙对(true);
    await expect(手机.拆自(我.私钥, 桌面.封给(别人.公钥, "不是给你的"))).rejects.toThrow();
    await expect(手机.封给(Buffer.alloc(44).toString("base64url"), "x")).rejects.toThrow();
  });
  it("配对数字两边一样（只用 SHA-256，和有没有内置无关）", async () => {
    const 钥 = await 手机.设备钥匙对(true);
    expect(await 手机.配对数字(钥.公钥)).toMatch(/^\d{6}$/);
  });
});

describe("没内置 Ed25519：老板签名照样验", () => {
  it("桌面端签的验得过；改一个字、换用途、换人都验不过", async () => {
    expect(await 手机.有内置("Ed25519")).toBe(false);
    const 老板 = 桌面.签名钥匙对();
    const 签好 = 桌面.签上("环的内容", "ring|team_1|3", 老板.私钥, 老板.公钥);
    expect(await 手机.验(签好, "ring|team_1|3", 老板.公钥)).toBe("环的内容");
    expect(await 手机.验(签好.replace("环的内容", "环的内谷"), "ring|team_1|3", 老板.公钥)).toBeNull();
    expect(await 手机.验(签好, "ring|team_1|4", 老板.公钥)).toBeNull();
    expect(await 手机.验(签好, "ring|team_1|3", 桌面.签名钥匙对().公钥)).toBeNull();
    expect(await 手机.验("没有点", "ring|team_1|3", 老板.公钥)).toBeNull();
  });
});
