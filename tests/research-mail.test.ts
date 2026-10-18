/**
 * 「粘贴询盘邮件」（背调补充方案第二期，2026-10-18）：邮件头解析（浏览器里跑的纯函数）、离线 IP 库、「邮件头」那一项的灯，
 * 以及服务端只收认得的字段（原文不进请求）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { 像邮件原文, 解析邮件, 认一跳, 是公网IP, 换了回复地址, 收邮件信号, 正文首段, type 邮件信号 } from "@/lib/research/verify/mail";
import { 解IP库, 查IP, 取IP库, 清IP库内存, 下载地址, v6数 } from "@/lib/research/verify/ip-country";
import { 邮件头项, 合成真实性 } from "@/lib/research/verify/rules";

/** 企业自建邮箱 + Foxmail：最早一跳是公司内网，下一跳是它自己的邮件服务器（公网） */
const 企业邮件 = [
  "Return-Path: <ahmed@abc-lighting.ae>",
  "Received: from mx1.ourfactory.cn (mx1.ourfactory.cn [121.40.1.2])",
  "\tby mail.ourfactory.cn with ESMTPS id 12345 for <sales@ourfactory.cn>;",
  "\tMon, 12 Oct 2026 09:01:02 +0800",
  "Authentication-Results: mail.ourfactory.cn; spf=pass smtp.mailfrom=abc-lighting.ae;",
  " dkim=pass header.d=abc-lighting.ae; dmarc=pass header.from=abc-lighting.ae",
  "Received: from mail.abc-lighting.ae (mail.abc-lighting.ae [94.200.1.10])",
  "\tby mx1.ourfactory.cn with ESMTP id 999; Mon, 12 Oct 2026 05:01:00 +0400",
  "Received: from DESKTOP-AHMED (unknown [192.168.1.23])",
  "\tby mail.abc-lighting.ae with ESMTPA; Mon, 12 Oct 2026 05:00:58 +0400",
  'From: "Ahmed" <Ahmed@ABC-Lighting.ae>',
  "To: sales@ourfactory.cn",
  "Subject: Inquiry: LED street light 150W",
  "Date: Mon, 12 Oct 2026 05:00:58 +0400",
  "X-Mailer: Foxmail 7.2.25.228",
  "Message-ID: <abc@abc-lighting.ae>",
  "",
  "Dear Sir,",
  "We need 2000 pcs LED street light 150W for a project in Dubai.",
  "Best regards,",
  "Ahmed | Purchasing | ABC Lighting LLC",
  "Tel: +971 4 123 4567",
  "",
  "-----Original Message-----",
  "From: sales@ourfactory.cn",
  "Tel: +86 571 8888 8888",
].join("\r\n");

/** Gmail 网页版：最早那一跳只有谷歌内部地址，下一跳是谷歌的发信服务器 */
const 网页版 = [
  "Delivered-To: sales@ourfactory.cn",
  "Received: by 2002:a05:7300:5a10:b0:ef:1234 with SMTP id k16csp1234567dyb;",
  "        Mon, 12 Oct 2026 02:10:11 -0700 (PDT)",
  "Authentication-Results: mx.ourfactory.cn; spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com",
  "Received: from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41])",
  "        by mx.google.com with SMTPS id a1sor123.2026.10.12.02.10.11",
  "Received: by 2002:a17:906:1234:b0:9a1:aaaa with SMTP id x2mr123; Mon, 12 Oct 2026 02:10:10 -0700 (PDT)",
  "From: Lumexa Trading <lumexa.trading@gmail.com>",
  "Reply-To: payments.lumexa@outlook.com",
  "To: sales@ourfactory.cn",
  "Subject: Urgent order",
  "Date: Mon, 12 Oct 2026 10:10:10 +0100",
  "",
  "Please send PI. WhatsApp +44 7911 123456",
].join("\n");

describe("邮件头解析（浏览器里跑，原文不出这台电脑）", () => {
  it("认得出是不是邮件原文：只粘正文的不算", () => {
    expect(像邮件原文(企业邮件)).toBe(true);
    expect(像邮件原文(`\n\n${网页版}`)).toBe(true);
    expect(像邮件原文("Dear Sir,\nWe need 2000 pcs LED street light.\nFrom: Ahmed")).toBe(false);
  });

  it("企业邮箱：跳过内网那一跳，取最早的公网 IP；认证结论、客户端、签名里的电话（引用的历史邮件不算）", () => {
    const x = 解析邮件(企业邮件);
    expect(x).toMatchObject({ 发件人: "ahmed@abc-lighting.ae", 发件IP: "94.200.1.10", IP来源: "最早一跳", spf: "pass", dkim: "pass", dmarc: "pass", 客户端: "Foxmail 7.2.25.228", 跳数: 3 });
    expect(x.经手).toBeUndefined();
    expect(x.回复到).toBeUndefined();
    expect(x.电话).toEqual(["+971 4 123 4567"]);
  });

  it("Gmail 网页版：最早的公网那一跳是谷歌的服务器 → 看不到对方 IP，写明是谁家；回复地址换成了别的邮箱", () => {
    const x = 解析邮件(网页版);
    expect(x.发件IP).toBeUndefined();
    expect(x.经手).toContain("谷歌");
    expect(x.发件人).toBe("lumexa.trading@gmail.com");
    expect(x.回复到).toBe("payments.lumexa@outlook.com");
    expect(换了回复地址(x)).toBe(true);
    expect(x.电话).toEqual(["+44 7911 123456"]);
  });

  it("X-Originating-IP 优先（Outlook 客户端 / 部分企业邮箱会写）；内网的不算", () => {
    const 头 = (ip: string) => `Received: from a.b (a.b [8.8.8.8]) by c.d\nX-Originating-IP: [${ip}]\nFrom: a@x.com\nSubject: hi\n\nbody`;
    expect(解析邮件(头("41.33.2.1"))).toMatchObject({ 发件IP: "41.33.2.1", IP来源: "X-Originating-IP" });
    expect(解析邮件(头("10.1.2.3"))).toMatchObject({ 发件IP: "8.8.8.8", IP来源: "最早一跳" });
  });

  it("一跳的几种写法；内网 / 保留地址", () => {
    expect(认一跳("from mail.abc.ae (mail.abc.ae [94.200.1.10]) by mx")).toMatchObject({ 主机: "mail.abc.ae", 反解: "mail.abc.ae", ip: "94.200.1.10" });
    expect(认一跳("from [5.6.7.8] (helo=x) by mx")?.ip).toBe("5.6.7.8");
    expect(认一跳("from x (unknown [IPv6:2a00:1450:4864:20::130]) by mx")?.ip).toBe("2a00:1450:4864:20::130");
    expect(认一跳("by 2002:a05:7300:5a10 with SMTP id k16")).toBeNull();
    for (const ip of ["10.0.0.1", "172.20.1.1", "192.168.1.1", "127.0.0.1", "100.64.0.1", "169.254.1.1", "198.18.0.5", "::1", "fd00::1", "fe80::1"]) expect(是公网IP(ip)).toBe(false);
    for (const ip of ["94.200.1.10", "8.8.8.8", "2a00:1450:4864:20::130"]) expect(是公网IP(ip)).toBe(true);
  });

  it("回复地址：同一个公司域名换个邮箱不算换；不同域名、同是 Gmail 但不是同一个人算", () => {
    expect(换了回复地址({ 发件人: "a@slv.com", 回复到: "sales@slv.com" })).toBe(false);
    expect(换了回复地址({ 发件人: "a@slv.com", 回复到: "a@slv-lighting.com" })).toBe(true);
    expect(换了回复地址({ 发件人: "a@gmail.com", 回复到: "b@gmail.com" })).toBe(true);
    expect(换了回复地址({ 发件人: "a@slv.com" })).toBe(false);
  });

  it("正文：quoted-printable 软换行接回去，base64 块和 MIME 头跳过，引用的历史邮件之前截断", () => {
    const t = "From: a@b.com\nSubject: x\n\n--boundary12345678\nContent-Type: text/plain\n\nTel: +49 2405 =\n4170\n" + "QUJD".repeat(20) + "\n> Tel: +86 1\nOn Mon, Oct 12, 2026 at 9:00 AM John wrote:\nTel: +86 571 1234 5678";
    const 体 = 正文首段(t);
    expect(体).toContain("+49 2405 4170");
    expect(体).not.toContain("QUJD");
    expect(体).not.toContain("+86");
  });
});

describe("服务端只收认得的字段（浏览器发来的不信）", () => {
  it("多余的字段（原文）丢掉；邮箱、IP、结论、电话、税号按格式卡住", () => {
    const 收 = 收邮件信号({
      原文: "Received: …",
      发件人: "Ahmed@ABC-lighting.ae",
      回复到: "not-an-email",
      发件IP: "94.200.1.10",
      IP来源: "X-Originating-IP",
      经手: "随便写的",
      spf: "pass",
      dkim: "<script>",
      电话: ["+971 4 123 4567", "javascript:alert(1)", 5],
      税号: "DE143454214",
      跳数: 3.7,
    });
    expect(收).toEqual({ 发件人: "ahmed@abc-lighting.ae", 发件IP: "94.200.1.10", IP来源: "X-Originating-IP", spf: "pass", 电话: ["+971 4 123 4567"], 税号: "DE143454214", 跳数: 4 });
    expect(收邮件信号({ 发件IP: "192.168.1.1" })).toBeUndefined();
    expect(收邮件信号("raw text")).toBeUndefined();
    expect(收邮件信号({ 经手: "谷歌（Gmail / Google Workspace）" })).toMatchObject({ 经手: "谷歌（Gmail / Google Workspace）" });
  });
});

describe("离线 IP 库（DB-IP Lite，本机查）", () => {
  const csv = ["1.0.0.0,1.0.0.255,AU", "94.200.0.0,94.200.255.255,AE", "10.0.0.0,10.255.255.255,ZZ", "2a00:1450::,2a00:1450:ffff:ffff:ffff:ffff:ffff:ffff,IE", "bad,line"].join("\n");
  it("按起始地址二分查；ZZ（保留）当没有；IPv6 也认", () => {
    const 库 = 解IP库(csv);
    expect(查IP(库, "94.200.1.10")).toBe("AE");
    expect(查IP(库, "1.0.0.7")).toBe("AU");
    expect(查IP(库, "10.1.1.1")).toBeNull();
    expect(查IP(库, "8.8.8.8")).toBeNull();
    expect(查IP(库, "2a00:1450:4864:20::130")).toBe("IE");
    expect(查IP(库, "::ffff:94.200.1.10")).toBe("AE");
    expect(查IP(库, "not-ip")).toBeNull();
    expect(v6数("::")).toBe(BigInt(0));
  });

  it("没有本机文件就下载，解得出才落盘；下不来返回 null（背调里当「查不了」）", async () => {
    清IP库内存();
    const 目录 = mkdtempSync(path.join(tmpdir(), "ipdb-"));
    const 行 = Array.from({ length: 10_001 }, (_, i) => `${Math.floor(i / 256) + 20}.${i % 256}.0.0,${Math.floor(i / 256) + 20}.${i % 256}.255.255,DE`);
    const gz = gzipSync([...行, "94.200.0.0,94.200.255.255,AE"].join("\n"));
    let 次 = 0;
    const 假 = (async () => {
      次 += 1;
      return new Response(次 === 1 ? "not found" : gz, { status: 次 === 1 ? 404 : 200 });
    }) as unknown as typeof fetch;
    const 库 = await 取IP库({ 目录, fetch: 假 });
    expect(次).toBe(2); // 这个月的还没出（404），退到上个月的
    expect(库 && 查IP(库, "94.200.1.10")).toBe("AE");
    expect(existsSync(path.join(目录, "dbip-country-lite.csv.gz"))).toBe(true);
    清IP库内存();
    const 坏 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await 取IP库({ 目录: mkdtempSync(path.join(tmpdir(), "ipdb-")), fetch: 坏 })).toBeNull();
    清IP库内存();
  });

  it("下载地址：这个月和上个月", () => {
    expect(下载地址(new Date("2026-01-01T03:00:00Z"))).toEqual([
      "https://download.db-ip.com/free/dbip-country-lite-2026-01.csv.gz",
      "https://download.db-ip.com/free/dbip-country-lite-2025-12.csv.gz",
    ]);
  });
});

describe("「邮件头」那一项（代码定灯，不出红）", () => {
  const 企 = 解析邮件(企业邮件);
  const 网 = 解析邮件(网页版);
  it("IP 国家和自称的对得上、认证都过：绿，带 DB-IP 署名", () => {
    const x = 邮件头项(企, "AE", { 自报国家: "AE" });
    expect(x).toMatchObject({ key: "ip", 灯: "green", 态: "已核" });
    expect(x.事实).toContain("发件 IP 94.200.1.10（最早一跳）在阿联酋，和对方自称的国家对得上");
    expect(x.事实).toContain("SPF 通过、DKIM 通过、DMARC 通过");
    expect(x.链接?.[0].url).toBe("https://db-ip.com");
  });
  it("对不上：黄，写清哪两国", () => {
    const x = 邮件头项(企, "NG", { 自报国家: "AE" });
    expect(x.灯).toBe("yellow");
    expect(x.事实).toContain("在尼日利亚，和对方自称的国家阿联酋对不上");
  });
  it("网页版看不到 IP：不扣分；但回复地址换了照样黄", () => {
    const x = 邮件头项(网, undefined, { 自报国家: "AE" });
    expect(x.灯).toBe("yellow");
    expect(x.事实).toContain("看不到对方自己的");
    expect(x.事实).toContain("回复地址被换成了 payments.lumexa@outlook.com");
    const 只看不到 = 邮件头项({ 电话: [], 跳数: 2, 经手: "谷歌（Gmail / Google Workspace）" } as 邮件信号, undefined);
    expect(只看不到).toMatchObject({ 灯: "gray", 态: "不适用" });
  });
  it("认证不过：黄；IP 库下不来：灰「查不了」", () => {
    expect(邮件头项({ ...企, dmarc: "fail" }, "AE").事实).toContain("DMARC 不通过");
    expect(邮件头项({ ...企, dmarc: "fail" }, "AE").灯).toBe("yellow");
    const 查不了 = 邮件头项({ 发件IP: "94.200.1.10", 电话: [], 跳数: 1 }, "查不了");
    expect(查不了).toMatchObject({ 灯: "gray", 态: "查不了" });
  });
  it("合成真实性：给了邮件项就用它，没给是「没贴询盘邮件原文」", () => {
    const 足迹 = { key: "footprint" as const, 灯: "green" as const, 态: "已核" as const, 事实: "Facebook 主页：有" };
    expect(合成真实性(null, 足迹, { 邮件项: 邮件头项(企, "AE") }).项.find((x) => x.key === "ip")?.灯).toBe("green");
    expect(合成真实性(null, 足迹).项.find((x) => x.key === "ip")?.事实).toContain("没贴询盘邮件原文");
  });
});
