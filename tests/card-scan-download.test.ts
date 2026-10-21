/**
 * 扫名片识别文件下载（2026-10-20 用户在伦敦：「识别模型没下载下来」）：
 *   - lib/card-scan/download.ts 下载齐：进度按线上大小算、断了 / 卡住自动重试、页面在后台时断了报「下载被中断」、4xx 不重试
 *   - app/ocr-files 出文件：按 Accept-Encoding 给预压缩的 .br / .gz、带长度和 ETag、认 Range、不许跳出 public/ocr
 * 真下载（限速、掐断）在 e2e/card-scan.spec.ts 和模拟器上测
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { 下载齐, 下载中断, 下载中断的话, 错的话, type 要下的 } from "@/lib/card-scan/download";

type 一次 = { 块: number[]; 然后?: "断" | "卡" | "完"; 状态?: number };

/** 假 fetch：每个地址按顺序给几次响应；块 = 每块多少字节，然后 = 读完这些块之后怎样 */
function 假抓(剧本: Record<string, 一次[]>) {
  const 次数: Record<string, number> = {};
  const 抓 = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = (次数[u] = (次数[u] ?? 0) + 1) - 1;
    const 这次 = 剧本[u]?.[Math.min(i, 剧本[u].length - 1)];
    if (!这次) throw new TypeError("Failed to fetch");
    if (这次.状态 && 这次.状态 !== 200) return new Response("no", { status: 这次.状态 });
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const n of 这次.块) {
          await new Promise((ok) => setTimeout(ok, 1));
          c.enqueue(new Uint8Array(n));
        }
        if (这次.然后 === "断") c.error(new TypeError("network error"));
        else if (这次.然后 === "卡") {
          // 不再给字节，直到被 abort
          const 断开 = () => c.error(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) 断开();
          else signal?.addEventListener("abort", 断开);
        } else c.close();
      },
    });
    return new Response(body, { status: 200 });
  });
  return { 抓: 抓 as unknown as typeof fetch, 次数 };
}

const 不歇 = () => Promise.resolve();

describe("下载齐", () => {
  const 文件们: 要下的[] = [
    { url: "/a", 原: 100, 传: 10 },
    { url: "/b", 原: 50, 传: 30 },
  ];

  it("都下完：进度按线上大小（传）算，最后到总数", async () => {
    const { 抓 } = 假抓({ "/a": [{ 块: [50, 50] }], "/b": [{ 块: [25, 25] }] });
    const 报 = vi.fn();
    await 下载齐(文件们, { 抓, 进: 报, 歇: 不歇, 文档: { hidden: false } });
    const 最后 = 报.mock.calls.at(-1)!;
    expect(最后).toEqual([40, 40]);
    // 中间按比例：/a 下了一半 = 5，/b 下了一半 = 15
    const 值们 = 报.mock.calls.map((c) => c[0]);
    expect(值们).toEqual([...值们].sort((x, y) => x - y));
    expect(值们.some((v) => v === 5 || v === 15 || v === 20)).toBe(true);
  });

  it("中途断了：自动重试那一个，别的不重下", async () => {
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [50], 然后: "断" }, { 块: [100] }], "/b": [{ 块: [50] }] });
    await 下载齐(文件们, { 抓, 歇: 不歇, 文档: { hidden: false } });
    expect(次数["/a"]).toBe(2);
    expect(次数["/b"]).toBe(1);
  });

  it("卡住（一直没有字节）：到点就断开重来", async () => {
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [10], 然后: "卡" }, { 块: [100] }], "/b": [{ 块: [50] }] });
    await 下载齐(文件们, { 抓, 歇: 不歇, 卡住毫秒: 30, 文档: { hidden: false } });
    expect(次数["/a"]).toBe(2);
  });

  it("页面在后台时断了：不重试，报「下载被中断」，别的也停", async () => {
    const 档 = { hidden: false };
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [50], 然后: "断" }], "/b": [{ 块: [10], 然后: "卡" }] });
    const p = 下载齐(文件们, { 抓, 歇: 不歇, 卡住毫秒: 10_000, 文档: 档 });
    档.hidden = true;
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(下载中断);
    expect(e.message).toBe(下载中断的话);
    expect(次数["/a"]).toBe(1);
  });

  it("一直下不到东西：试够次数报网络错（会被说成「没下载下来」）", async () => {
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [], 然后: "断" }], "/b": [{ 块: [50] }] });
    const e = await 下载齐(文件们, { 抓, 歇: 不歇, 空手次数: 3, 文档: { hidden: false } }).catch((x) => x);
    expect(String(e.message)).toMatch(/network/);
    expect(次数["/a"]).toBe(3);
  });

  it("下到了东西的失败不算空手：断好几次也接着试，直到下完", async () => {
    const 断 = { 块: [10], 然后: "断" as const };
    const { 抓, 次数 } = 假抓({ "/a": [断, 断, 断, 断, 断, { 块: [100] }], "/b": [{ 块: [50] }] });
    await 下载齐(文件们, { 抓, 歇: 不歇, 空手次数: 2, 文档: { hidden: false } });
    expect(次数["/a"]).toBe(6);
  });

  it("404：文件不在，不重试", async () => {
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [], 状态: 404 }], "/b": [{ 块: [50] }] });
    const e = await 下载齐(文件们, { 抓, 歇: 不歇, 文档: { hidden: false } }).catch((x) => x);
    expect(String(e.message)).toContain("404");
    expect(次数["/a"]).toBe(1);
  });

  it("500：当网络问题重试", async () => {
    const { 抓, 次数 } = 假抓({ "/a": [{ 块: [], 状态: 502 }, { 块: [100] }], "/b": [{ 块: [50] }] });
    await 下载齐(文件们, { 抓, 歇: 不歇, 文档: { hidden: false } });
    expect(次数["/a"]).toBe(2);
  });
});

describe("下载失败给人看的话", () => {
  it("下载中断：原话，能再试", () => {
    expect(错的话(new 下载中断())).toEqual({ 话: "下载被中断，保持在这个页面再点一次", 能重试: true });
  });
  it("Chrome / Safari 的网络错：没下载下来，能再试", () => {
    for (const m of ["Failed to fetch dynamically imported module: /ocr/v1/paddle.js", "Load failed", "Importing a module script failed.", "network: 识别文件下不下来"]) {
      const r = 错的话(new TypeError(m));
      expect(r.能重试).toBe(true);
      expect(r.话).toContain("识别模型没下载下来");
    }
  });
  it("别的错：没认出来，不给再试", () => {
    expect(错的话(new Error("OCR worker failed."))).toEqual({ 话: "没认出来：OCR worker failed.", 能重试: false });
  });
});

describe("app/ocr-files 出识别文件", () => {
  let 临时: string;
  let 路由: typeof import("@/app/ocr-files/[...path]/route");
  const 原 = Buffer.from("console.log('paddle');".repeat(2000));
  beforeAll(async () => {
    临时 = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-files-"));
    const v1 = path.join(临时, "public/ocr/v1");
    fs.mkdirSync(path.join(v1, "ort"), { recursive: true });
    fs.writeFileSync(path.join(v1, "paddle.js"), 原);
    fs.writeFileSync(path.join(v1, "paddle.js.br"), zlib.brotliCompressSync(原));
    fs.writeFileSync(path.join(v1, "paddle.js.gz"), zlib.gzipSync(原));
    fs.writeFileSync(path.join(v1, "ort/x.wasm"), Buffer.alloc(1000, 7));
    fs.writeFileSync(path.join(v1, "manifest.json"), "{}");
    fs.writeFileSync(path.join(临时, "secret.txt"), "no");
    vi.spyOn(process, "cwd").mockReturnValue(临时);
    vi.resetModules();
    路由 = await import("@/app/ocr-files/[...path]/route");
  });
  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(临时, { recursive: true, force: true });
  });
  const 取 = (段们: string[], 头: Record<string, string> = {}) =>
    路由.GET(new Request("http://x/ocr/" + 段们.join("/"), { headers: 头 }), { params: Promise.resolve({ path: 段们 }) });

  it("浏览器要 br 就给预压缩的 br：带长度、编码、ETag、一年缓存", async () => {
    const r = await 取(["v1", "paddle.js"], { "accept-encoding": "gzip, deflate, br, zstd" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBe("br");
    const 体 = Buffer.from(await r.arrayBuffer());
    expect(Number(r.headers.get("content-length"))).toBe(体.length);
    expect(zlib.brotliDecompressSync(体).equals(原)).toBe(true);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("只认 gzip 给 gz；什么都不认（或 br;q=0）给原文件", async () => {
    expect((await 取(["v1", "paddle.js"], { "accept-encoding": "gzip" })).headers.get("content-encoding")).toBe("gzip");
    expect((await 取(["v1", "paddle.js"], { "accept-encoding": "br;q=0, gzip" })).headers.get("content-encoding")).toBe("gzip");
    const r = await 取(["v1", "paddle.js"]);
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer()).equals(原)).toBe(true);
  });

  it("没有预压缩版的文件给原文件；wasm 的类型对", async () => {
    const r = await 取(["v1", "ort", "x.wasm"], { "accept-encoding": "br, gzip" });
    expect(r.headers.get("content-encoding")).toBeNull();
    expect(r.headers.get("content-type")).toBe("application/wasm");
    expect(r.headers.get("content-length")).toBe("1000");
  });

  it("Range：按传出去的那份字节给 206；If-Range 对不上给整份；超出给 416", async () => {
    const 整 = await 取(["v1", "paddle.js"], { "accept-encoding": "br" });
    const etag = 整.headers.get("etag")!;
    const 总 = Number(整.headers.get("content-length"));
    const 段 = await 取(["v1", "paddle.js"], { "accept-encoding": "br", range: "bytes=10-19", "if-range": etag });
    expect(段.status).toBe(206);
    expect(段.headers.get("content-range")).toBe(`bytes 10-19/${总}`);
    expect((await 段.arrayBuffer()).byteLength).toBe(10);
    const 换过 = await 取(["v1", "paddle.js"], { "accept-encoding": "br", range: "bytes=10-19", "if-range": '"other"' });
    expect(换过.status).toBe(200);
    const 超 = await 取(["v1", "paddle.js"], { "accept-encoding": "br", range: `bytes=${总 + 5}-` });
    expect(超.status).toBe(416);
  });

  it("If-None-Match 对上回 304；br 和 gzip 的 ETag 不一样", async () => {
    const br = await 取(["v1", "paddle.js"], { "accept-encoding": "br" });
    const gz = await 取(["v1", "paddle.js"], { "accept-encoding": "gzip" });
    expect(br.headers.get("etag")).not.toBe(gz.headers.get("etag"));
    const 再 = await 取(["v1", "paddle.js"], { "accept-encoding": "br", "if-none-match": br.headers.get("etag")! });
    expect(再.status).toBe(304);
  });

  it("manifest.json 每次问一下（no-cache）", async () => {
    expect((await 取(["v1", "manifest.json"])).headers.get("cache-control")).toBe("no-cache");
  });

  it("跳不出 public/ocr，不存在的回 404", async () => {
    for (const 段们 of [["..", "..", "secret.txt"], ["v1", ".."], [".hidden"], ["v1", "nope.js"], []]) {
      expect((await 取(段们)).status).toBe(404);
    }
  });

  it("HEAD 只给头", async () => {
    const r = await 路由.HEAD(new Request("http://x/ocr/v1/paddle.js", { method: "HEAD", headers: { "accept-encoding": "br" } }), { params: Promise.resolve({ path: ["v1", "paddle.js"] }) });
    expect(r.status).toBe(200);
    expect(Number(r.headers.get("content-length"))).toBeGreaterThan(0);
    expect(r.body).toBeNull();
  });
});
