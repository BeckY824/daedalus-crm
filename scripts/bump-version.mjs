#!/usr/bin/env node
/**
 * 改版本号。**别再用全文替换干这件事。**
 *
 * 2026-09-17 查 CI 全红查出来的：`chore: 0.28.0` 和 `chore: 0.29.0` 两次 bump
 * 是把旧版本号在 package-lock.json 里全文替换成新的。而 `node_modules/scheduler`
 * 的真实版本恰好是 `0.27.0`——和当时的应用版本一模一样，于是它跟着被改成了
 * 0.28.0、0.29.0。react-dom 要 `^0.27.0`，锁文件里写着别的，`npm ci` 当场拒绝，
 * 三个 workflow（CI / 镜像 / 桌面包）一起挂。本地 `npm run dev` 和 `npm test`
 * 一个字都不会说，因为它们用的是已经装好的 node_modules。
 *
 * 所以这个脚本只动四个确定的位置：
 *   package.json.version
 *   desktop/package.json.version
 *   package-lock.json 的顶层 version 和 packages[""].version
 *   desktop/package-lock.json 的同两处
 * 别的一个字节都不碰。
 *
 * 用法：node scripts/bump-version.mjs 0.31.0
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const 根 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const 新版 = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(新版 ?? "")) {
  console.error("用法：node scripts/bump-version.mjs 0.31.0");
  process.exit(1);
}

/** 只改这一个 JSON 键，其余按原文回写（缩进 2 + 末尾换行，和 npm 自己写出来的一致） */
function 改(相对路径, 改法) {
  const p = path.join(根, 相对路径);
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  改法(d);
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  console.log("  " + 相对路径);
}

console.log(`版本号 → ${新版}`);
for (const pkg of ["package.json", "desktop/package.json"]) {
  改(pkg, (d) => void (d.version = 新版));
}
for (const lock of ["package-lock.json", "desktop/package-lock.json"]) {
  改(lock, (d) => {
    d.version = 新版;
    if (d.packages?.[""]) d.packages[""].version = 新版;
  });
}
console.log("\n接下来：写 CHANGELOG、提交 `chore: " + 新版 + "`、跑一次 `npm ci --dry-run` 确认锁文件没歪。");
