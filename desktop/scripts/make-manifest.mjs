#!/usr/bin/env node
/**
 * 给差量更新生成清单：zip 里每个文件的路径、内容哈希、权限、以及它的压缩数据在 zip 里的
 * 字节位置。客户端拿它和已装的 .app 比对，只对变了的条目发 HTTP Range，不下整包。
 *
 * 用法： node scripts/make-manifest.mjs <app.zip> <版本号> <输出 .manifest.json.gz>
 *
 * zip 必须是 `ditto -c -k --keepParent --norsrc X.app X.app.zip` 打的：逐条 deflate、
 * 保符号链接和权限，解开后 codesign --verify 能过（2026-09-16 实测）。
 *
 * 几件 2026-09-16 在真 zip 上查清、决定了下面怎么写的事：
 *   - ditto 的 deflate 条目**全部带数据描述符**（flag bit 3）：本地文件头里的长度字段是 0，
 *     尺寸只能从中央目录取（yauzl 给的就是中央目录的）。
 *   - 压缩数据的起点 = 本地文件头偏移 + 30 + 本地头里的名字长 + 扩展区长。
 *     **要读本地头自己的两个长度**，不能用中央目录里的——两处的扩展区可以不一样。
 *   - 符号链接：external_attr 高 16 位是 unix mode，S_IFLNK 位置 1，条目内容就是目标路径。
 *   - 没有 ZIP64（161 MB、2900 条目远没到线），这里不处理 ZIP64，超了直接报错。
 *
 * 只在构建期跑，所以能用 desktop/node_modules 里的 yauzl；客户端那边解压只靠 node 自带的 zlib。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");

const [zipPath, 版本, 输出] = process.argv.slice(2);
if (!zipPath || !版本 || !输出) {
  console.error("用法：node scripts/make-manifest.mjs <app.zip> <版本号> <输出 .manifest.json.gz>");
  process.exit(2);
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function 打开(p) {
  return new Promise((resolve, reject) => yauzl.open(p, { lazyEntries: true, autoClose: false }, (e, z) => (e ? reject(e) : resolve(z))));
}
function 读流(zipfile, entry) {
  return new Promise((resolve, reject) => zipfile.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s))));
}
function 流哈希(stream) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    stream.on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
function 流内容(stream) {
  return new Promise((resolve, reject) => {
    const 块 = [];
    stream.on("data", (c) => 块.push(c)).on("end", () => resolve(Buffer.concat(块))).on("error", reject);
  });
}
async function 文件哈希(p) {
  return 流哈希(fs.createReadStream(p));
}

/** 压缩数据在 zip 里的起点。读本地文件头自己的名字长和扩展区长，见顶部说明 */
function 数据偏移(fd, entry) {
  const 头 = Buffer.alloc(30);
  fs.readSync(fd, 头, 0, 30, entry.relativeOffsetOfLocalHeader);
  if (头.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.fileName}：本地文件头签名不对，zip 可能损坏`);
  const 名长 = 头.readUInt16LE(26);
  const 扩长 = 头.readUInt16LE(28);
  return entry.relativeOffsetOfLocalHeader + 30 + 名长 + 扩长;
}

const zipfile = await 打开(zipPath);
const fd = fs.openSync(zipPath, "r");
const entries = [];
let 包名 = null;
const 统计 = { 文件: 0, 链接: 0, 目录: 0, deflate: 0, stored: 0 };

await new Promise((resolve, reject) => {
  zipfile.on("error", reject);
  zipfile.on("end", resolve);
  zipfile.on("entry", async (entry) => {
    try {
      const name = entry.fileName;
      // --keepParent 让所有条目都以 "X.app/" 开头。记下包名，路径存成相对包根的
      const 顶 = name.split("/")[0];
      if (!包名) 包名 = 顶;
      else if (顶 !== 包名) throw new Error(`zip 里不止一个顶层目录：${包名} 和 ${顶}`);
      const rel = name.slice(包名.length + 1);

      if (name.endsWith("/")) {
        统计.目录++;
        zipfile.readEntry();
        return;
      }
      if (entry.relativeOffsetOfLocalHeader >= 2 ** 32 || entry.compressedSize >= 2 ** 32) {
        throw new Error("出现 ZIP64 条目，这个脚本没处理它");
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0o7777;
      const 类型 = ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK ? "l" : "f";
      const method = entry.compressionMethod;
      if (method !== 0 && method !== 8) throw new Error(`${name}：压缩方法 ${method} 不认识，只处理 stored(0) 和 deflate(8)`);

      if (类型 === "l") {
        统计.链接++;
        const target = (await 流内容(await 读流(zipfile, entry))).toString("utf8");
        entries.push({ p: rel, t: "l", target, m: mode });
      } else {
        统计.文件++;
        method === 8 ? 统计.deflate++ : 统计.stored++;
        const h = await 流哈希(await 读流(zipfile, entry));
        entries.push({
          p: rel,
          t: "f",
          h,
          s: entry.uncompressedSize,
          m: mode,
          // 客户端按这三个字段发 Range：[off, off+cs)，method=8 时 inflateRaw
          off: 数据偏移(fd, entry),
          cs: entry.compressedSize,
          method,
        });
      }
      zipfile.readEntry();
    } catch (e) {
      reject(e);
    }
  });
  zipfile.readEntry();
});
fs.closeSync(fd);
zipfile.close();

const 清单 = {
  v: 1,
  version: 版本,
  bundle: 包名,
  zip: { size: fs.statSync(zipPath).size, sha256: await 文件哈希(zipPath) },
  entries,
};
const 字节 = zlib.gzipSync(JSON.stringify(清单), { level: 9 });
fs.mkdirSync(path.dirname(输出), { recursive: true });
fs.writeFileSync(输出, 字节);

const 总原 = entries.reduce((a, e) => a + (e.s || 0), 0);
console.log(
  `清单 → ${输出}（${(字节.length / 1024).toFixed(0)} KB）\n` +
    `  ${包名}：${统计.文件} 个文件（deflate ${统计.deflate} / stored ${统计.stored}）、${统计.链接} 个符号链接、${统计.目录} 个目录\n` +
    `  解开 ${(总原 / 1048576).toFixed(1)} MB，zip ${(清单.zip.size / 1048576).toFixed(1)} MB`,
);
