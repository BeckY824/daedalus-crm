/**
 * 差量更新的客户端（desktop/delta.js）。
 *
 * 纯逻辑部分（Range 规划、比对、Range 请求的判定）直接测。
 * 组装那条链用一个真的本地 HTTP 服务测：造「旧」「新」两个假 .app，新的比旧的改一个、加一个、
 * 删一个、改名一个；ditto 打新的 zip + 生成清单；服务只认 Range、顺便数请求和字节；
 * 以旧包为已装跑 差量安装——出来的 .new 必须和新包逐字节一致，且只下了变了的那几个。
 * codesign 对假包必然失败，所以 运行 注入成记录器（install.js 的测试也是这么做的）。
 *
 * ditto 是 macOS 的，集成那组在 CI 的 ubuntu 跳过；纯逻辑那组哪都跑。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const require_ = createRequire(import.meta.url);
const 差量 = require_("../desktop/delta.js");
const 生成器 = path.resolve(__dirname, "../desktop/scripts/make-manifest.mjs");
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

type 条目 = { p: string; t: "f"; h: string; s: number; m: number; off: number; cs: number; method: 0 | 8 } | { p: string; t: "l"; target: string; m: number };
const F = (p: string, off: number, cs: number, h = "h" + p): 条目 => ({ p, t: "f", h, s: cs, m: 0o644, off, cs, method: 8 });

describe("规划Range", () => {
  it("挨着的并成一段，隔太远的分开；输入乱序也按偏移排", () => {
    const 段 = 差量.规划Range([F("c", 1000, 100), F("a", 0, 100), F("b", 100, 100), F("d", 100000, 50)], { 间隔: 500 });
    expect(段.map((s: { start: number; end: number; entries: 条目[] }) => [s.start, s.end, s.entries.map((e) => e.p)])).toEqual([
      [0, 200, ["a", "b"]],
      [1000, 1100, ["c"]],
      [100000, 100050, ["d"]],
    ]);
  });
  it("空输入给空", () => {
    expect(差量.规划Range([])).toEqual([]);
  });
});

describe("比对", () => {
  it("同路径同哈希复用；别处有同哈希也复用（改名）；都没有才下；链接单列", () => {
    const entries: 条目[] = [F("same", 0, 1, "H1"), F("renamed", 1, 1, "H2"), F("changed", 2, 1, "H3"), { p: "lnk", t: "l", target: "x", m: 0o755 }];
    const 本地 = { 按路径: new Map([["same", "H1"], ["changed", "OLD"]]), 按哈希: new Map([["H1", "/i/same"], ["H2", "/i/oldname"], ["OLD", "/i/changed"]]) };
    const r = 差量.比对(entries, 本地);
    expect(r.复用.map((x: { e: 条目; from: string | null }) => [x.e.p, x.from])).toEqual([["same", null], ["renamed", "/i/oldname"]]);
    expect(r.下载.map((e: 条目) => e.p)).toEqual(["changed"]);
    expect(r.链接.map((e: 条目) => e.p)).toEqual(["lnk"]);
  });
});

describe("取Range 的判定", () => {
  const 假 = (status: number, body: Buffer) => async () => ({ status, ok: status < 300, arrayBuffer: async () => body, url: "" });
  it("206 且长度对才收", async () => {
    const b = await 差量.取Range({ url: "x", start: 10, end: 14, fetch: 假(206, Buffer.from("abcd")) });
    expect(b.toString()).toBe("abcd");
  });
  it("200 表示服务器不理 Range、要给整个文件——必须拒绝，绝不能默默收下 160 MB", async () => {
    await expect(差量.取Range({ url: "x", start: 0, end: 4, fetch: 假(200, Buffer.alloc(4)) })).rejects.toThrow(/206/);
  });
  it("403 标成过期，让上层重解析直链", async () => {
    await expect(差量.取Range({ url: "x", start: 0, end: 4, fetch: 假(403, Buffer.alloc(0)) })).rejects.toMatchObject({ 过期: true });
  });
  it("长度不对就抛", async () => {
    await expect(差量.取Range({ url: "x", start: 0, end: 4, fetch: 假(206, Buffer.alloc(3)) })).rejects.toThrow(/字节/);
  });
});

describe.skipIf(process.platform !== "darwin")("整条链：旧包 → 差量 → 新包", () => {
  let 沙盒: string, 旧: string, 新: string, zip: string, 清单路径: string, server: http.Server, base: string;
  const 统计 = { 请求: 0, 字节: 0, 整包请求: 0 };

  function 造包(root: string, 变体: "旧" | "新") {
    fs.mkdirSync(path.join(root, "Contents/MacOS"), { recursive: true });
    fs.mkdirSync(path.join(root, "Contents/Resources/chunks"), { recursive: true });
    fs.writeFileSync(path.join(root, "Contents/Info.plist"), `<plist>${变体 === "新" ? "1.1" : "1.0"}</plist>`.repeat(50)); // 改了
    fs.writeFileSync(path.join(root, "Contents/MacOS/App"), "#!/bin/sh\necho app\n", { mode: 0o755 }); // 没变
    fs.writeFileSync(path.join(root, "Contents/Resources/big.bin"), Buffer.alloc(300 * 1024, 7)); // 没变、大
    fs.writeFileSync(path.join(root, `Contents/Resources/chunks/${变体 === "新" ? "chunk-new.js" : "chunk-old.js"}`), "same content ".repeat(2000)); // 只是改名
    if (变体 === "旧") fs.writeFileSync(path.join(root, "Contents/Resources/removed.txt"), "gone"); // 新包里没有
    if (变体 === "新") fs.writeFileSync(path.join(root, "Contents/Resources/added.txt"), "brand new ".repeat(100)); // 新增
    fs.symlinkSync("../Info.plist", path.join(root, "Contents/Resources/link"));
  }

  beforeAll(async () => {
    沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "delta-test-"));
    旧 = path.join(沙盒, "installed", "Fake.app");
    新 = path.join(沙盒, "release", "Fake.app");
    造包(旧, "旧");
    造包(新, "新");
    zip = path.join(沙盒, "Fake.app.zip");
    清单路径 = path.join(沙盒, "m.json.gz");
    execFileSync("ditto", ["-c", "-k", "--keepParent", "--norsrc", 新, zip]);
    execFileSync(process.execPath, [生成器, zip, "2.0.0", 清单路径], { stdio: "pipe" });

    // 只认 Range 的服务；HEAD 给 200（解析直链要用）；没带 Range 的 GET 给整包（用来证明客户端会拒绝）
    server = http.createServer((req, res) => {
      const f = req.url === "/m.json.gz" ? 清单路径 : zip;
      const size = fs.statSync(f).size;
      if (req.method === "HEAD") return res.writeHead(200, { "Content-Length": size }).end();
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!m || req.url === "/m.json.gz") {
        if (req.url !== "/m.json.gz") 统计.整包请求++;
        res.writeHead(200, { "Content-Length": size });
        return fs.createReadStream(f).pipe(res);
      }
      const [start, end] = [Number(m[1]), Number(m[2])];
      统计.请求++;
      统计.字节 += end - start + 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      fs.createReadStream(f, { start, end }).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(沙盒, { recursive: true, force: true });
  });

  function 树(root: string) {
    const out: Record<string, string> = {};
    (function 走(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const rel = path.relative(root, p);
        if (e.isSymbolicLink()) out[rel] = "link:" + fs.readlinkSync(p);
        else if (e.isDirectory()) 走(p);
        else out[rel] = `${(fs.statSync(p).mode & 0o7777).toString(8)}:${sha(fs.readFileSync(p))}`;
      }
    })(root);
    return out;
  }

  it("组装出来的 .new 和新包逐字节一致（含权限、符号链接、删掉的不在、改名的在），且只下了变了的", async () => {
    const 调用: string[][] = [];
    // 假包过不了真的 codesign；桩在第一次 --verify 抛，逼它走「验 → ad-hoc 重签 → 再验」那条恢复路径
    const 运行 = async (c: string, a: string[]) => {
      调用.push([c, ...a]);
      if (a[0] === "--verify" && 调用.filter((x) => x[1] === "--verify").length === 1) throw new Error("code has no resources");
    };
    const 日志: string[] = [];
    const r = await 差量.差量安装({
      清单Url: `${base}/m.json.gz`, zipUrl: `${base}/Fake.app.zip`, 已装: 旧,
      缓存路径: path.join(沙盒, "cache.json"), 运行, 日志: (l: string) => 日志.push(l),
    });
    expect(r.目标).toBe(`${旧}.new`);
    expect(树(r.目标)).toEqual(树(新));
    // 改了 1 个（Info.plist）+ 新增 1 个（added.txt）= 下 2 个；改名那个和没变的复用
    expect(r.统计.下载).toBe(2);
    expect(r.统计.复用).toBe(3);
    expect(统计.整包请求).toBe(0);
    expect(统计.字节).toBeLessThan(fs.statSync(zip).size / 4);
    expect(调用.map((c) => c[1])).toEqual(["--verify", "--force", "--verify"]);
    expect(fs.existsSync(path.join(沙盒, "cache.json"))).toBe(true);
  });

  it("再跑一次是断点续传：.new 里已经好了的一个字节都不再下", async () => {
    const 之前 = 统计.字节;
    const r = await 差量.差量安装({ 清单Url: `${base}/m.json.gz`, zipUrl: `${base}/Fake.app.zip`, 已装: 旧, 运行: async () => {} });
    expect(r.统计.下载).toBe(0);
    expect(统计.字节).toBe(之前);
  });

  it("变得太多就退回整包，而不是硬差量", async () => {
    await expect(
      差量.差量安装({ 清单Url: `${base}/m.json.gz`, zipUrl: `${base}/Fake.app.zip`, 已装: path.join(沙盒, "nowhere", "Fake.app"), 最大占比: 0.01, 运行: async () => {} }),
    ).rejects.toThrow(差量.退回整包);
  });

  it("包名对不上直接退回整包", async () => {
    const 别的 = path.join(沙盒, "Other.app");
    fs.mkdirSync(别的, { recursive: true });
    await expect(差量.差量安装({ 清单Url: `${base}/m.json.gz`, zipUrl: `${base}/Fake.app.zip`, 已装: 别的, 运行: async () => {} })).rejects.toThrow(/包名/);
  });
});
