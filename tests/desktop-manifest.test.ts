/**
 * 差量更新的清单生成器（desktop/scripts/make-manifest.mjs）。
 *
 * 钉的是客户端要靠的那几个字段是不是准的：按清单里的 off/cs 从 zip 里切字节、按 method
 * 解压，得到的内容哈希必须等于清单里的 h、也等于原文件；权限和符号链接目标要原样带过来。
 * 用一个几 KB 的假 .app 走同一套 ditto → 生成 → 验证的流程，不碰那个 161 MB 的真包。
 *
 * 要 ditto（macOS 自带），CI 的 ubuntu 跳过——真包上的全量验证 2026-09-16 在本机做过一次。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";

const 脚本 = path.resolve(__dirname, "../desktop/scripts/make-manifest.mjs");

/** 清单条目，和 make-manifest.mjs 写出来的一致 */
type 条目 =
  | { p: string; t: "f"; h: string; s: number; m: number; off: number; cs: number; method: 0 | 8 }
  | { p: string; t: "l"; target: string; m: number };
type 清单类型 = { v: number; version: string; bundle: string; zip: { size: number; sha256: string }; entries: 条目[] };
const 文件 = (m: 清单类型) => m.entries.filter((e): e is Extract<条目, { t: "f" }> => e.t === "f");
const 按路径 = (m: 清单类型) => Object.fromEntries(m.entries.map((e) => [e.p, e])) as Record<string, 条目>;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe.skipIf(process.platform !== "darwin")("差量清单", () => {
  let 沙盒: string, app: string, zip: string, 清单: 清单类型;

  beforeAll(() => {
    沙盒 = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-test-"));
    app = path.join(沙盒, "Fake.app");
    fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents/Resources/deep/er"), { recursive: true });
    // 可压缩的文本、一个可执行文件、一个随机字节（deflate 压不动，ditto 会用 stored）、一个空文件
    fs.writeFileSync(path.join(app, "Contents/Info.plist"), "<plist>".repeat(200));
    fs.writeFileSync(path.join(app, "Contents/MacOS/Fake"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    fs.writeFileSync(path.join(app, "Contents/Resources/deep/er/blob.bin"), crypto.randomBytes(64 * 1024));
    fs.writeFileSync(path.join(app, "Contents/Resources/empty"), "");
    fs.symlinkSync("../Info.plist", path.join(app, "Contents/Resources/link"));
    zip = path.join(沙盒, "Fake.app.zip");
    execFileSync("ditto", ["-c", "-k", "--keepParent", "--norsrc", app, zip]);
    execFileSync(process.execPath, [脚本, zip, "9.9.9", path.join(沙盒, "m.json.gz")], { stdio: "pipe" });
    清单 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(沙盒, "m.json.gz"))).toString());
  });
  afterAll(() => fs.rmSync(沙盒, { recursive: true, force: true }));

  it("顶层信息：包名、版本、整包哈希", () => {
    expect(清单.v).toBe(1);
    expect(清单.version).toBe("9.9.9");
    expect(清单.bundle).toBe("Fake.app");
    expect(清单.zip.size).toBe(fs.statSync(zip).size);
    expect(清单.zip.sha256).toBe(sha(fs.readFileSync(zip)));
  });

  it("路径相对包根，文件 4 个、链接 1 个，目录不出现", () => {
    expect(文件(清单).map((e) => e.p).sort()).toEqual(["Contents/Info.plist", "Contents/MacOS/Fake", "Contents/Resources/deep/er/blob.bin", "Contents/Resources/empty"]);
    expect(清单.entries.filter((e) => e.t === "l")).toEqual([{ p: "Contents/Resources/link", t: "l", target: "../Info.plist", m: expect.any(Number) }]);
  });

  it("客户端核心路径：按 off/cs 切字节 → 按 method 解压 → 哈希等于清单的 h 也等于原文件", () => {
    const fd = fs.openSync(zip, "r");
    for (const e of 文件(清单)) {
      const raw = Buffer.alloc(e.cs);
      fs.readSync(fd, raw, 0, e.cs, e.off);
      const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
      expect(data.length, e.p).toBe(e.s);
      expect(sha(data), e.p).toBe(e.h);
      expect(sha(fs.readFileSync(path.join(app, e.p))), e.p).toBe(e.h);
    }
    fs.closeSync(fd);
  });

  it("压缩方法只会是 stored(0) 或 deflate(8)；文本一定是 deflate；空文件 s 为 0", () => {
    // 原以为随机字节 ditto 会存成 stored，实测它照样 deflate（真包 2221 deflate 对 1 stored）。
    // 所以不断言 blob 走哪种，只断言取值合法——两种分支都由上面那条「切字节→解压→哈希」覆盖
    const by = 按路径(清单);
    for (const e of 文件(清单)) expect([0, 8], e.p).toContain(e.method);
    expect(by["Contents/Info.plist"]).toMatchObject({ t: "f", method: 8 });
    expect(by["Contents/Resources/empty"]).toMatchObject({ t: "f", s: 0 });
  });

  it("权限原样带过来：可执行的是 755", () => {
    const by = 按路径(清单);
    expect(by["Contents/MacOS/Fake"].m).toBe(0o755);
    expect(by["Contents/Info.plist"].m & 0o111).toBe(0);
  });
});
