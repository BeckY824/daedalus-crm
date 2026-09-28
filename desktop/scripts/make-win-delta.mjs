#!/usr/bin/env node
/**
 * Windows 差量更新的两个产物：win-unpacked 打成的 zip，和它的清单（make-manifest.mjs 生成）。
 * 客户端拿清单和安装目录比，只对 zip 发 Range 取变了的文件（见 delta.js、windows-install.js）。
 *
 * 用法： node scripts/make-win-delta.mjs <win-unpacked 目录> <版本号> <输出目录> [架构=x64]
 * 产物： <输出目录>/Daedalus-CRM-<版本>-<架构>-win.zip 和 …-win.manifest.json.gz
 *
 * CI 和单测都走这一个脚本——单测验的就是 CI 发出去的那种 zip。
 *
 * 用 electron-builder 自带的 7zip-bin（7za），不靠 PATH 里有没有 7z：
 *   - `-tzip -mm=Deflate`：每个条目各自 deflate，客户端 inflateRaw 就能解；不能用 7z 格式（整块压缩，没法按条目 Range）
 *   - `-mcu=on`：文件名一律按 UTF-8 写（带 UTF-8 标志位），非 ASCII 名字不会按代码页变乱码
 *   - `-mtc=off`：不写 NTFS 时间戳扩展区，条目头小一点；清单读本地头自己的扩展区长，写不写都对得上
 *   - 在 win-unpacked 的父目录里跑、只给目录名：zip 里的路径都以 win-unpacked/ 开头，清单要求只有一个顶层目录
 * 文件名里不带空格：GitHub 会把空格换成点，名字就和本地对不上了。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const 这里 = path.dirname(fileURLToPath(import.meta.url));

const [目录参数, 版本, 输出参数, 架构 = "x64"] = process.argv.slice(2);
if (!目录参数 || !版本 || !输出参数) {
  console.error("用法：node scripts/make-win-delta.mjs <win-unpacked 目录> <版本号> <输出目录> [架构=x64]");
  process.exit(2);
}
const 源 = path.resolve(目录参数);
const 输出 = path.resolve(输出参数);
if (!fs.statSync(源).isDirectory()) throw new Error(`${源} 不是目录`);
fs.mkdirSync(输出, { recursive: true });

const 基名 = `Daedalus-CRM-${版本}-${架构}-win`;
const zip = path.join(输出, `${基名}.zip`);
const 清单 = path.join(输出, `${基名}.manifest.json.gz`);
fs.rmSync(zip, { force: true });

const { path7za } = require("7zip-bin");
execFileSync(path7za, ["a", "-tzip", "-mm=Deflate", "-mx=7", "-mtc=off", "-mcu=on", "-bd", "-bso0", zip, path.basename(源)], {
  cwd: path.dirname(源),
  stdio: ["ignore", "inherit", "inherit"],
});
execFileSync(process.execPath, [path.join(这里, "make-manifest.mjs"), zip, 版本, 清单], { stdio: "inherit" });
console.log(`Windows 差量产物 → ${path.basename(zip)}、${path.basename(清单)}`);
