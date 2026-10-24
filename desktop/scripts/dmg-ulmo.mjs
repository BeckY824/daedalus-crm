#!/usr/bin/env node
/**
 * 把这一版的 dmg 从 UDZO（zlib）换成 ULMO（LZMA），`npm run dist:mac` 的最后一步（2026-10-20）。
 *
 * electron-builder 只出得了 UDZO / UDBZ / ULFO，压得最小的 ULMO 要拿 hdiutil 再转一道。
 * 0.46.22 实测：145.6 MB 的 dmg，转完小三成多（数字见 PR）。macOS 10.15 起都挂得上，
 * 应用内整包更新（install.js 用 hdiutil attach）和双击安装都不受影响。
 *
 * 必须在算哈希之前跑：发版脚本、官网 latest.json、GitCode 都用 GitHub Release 上传后的 sha256，
 * 那时 dmg 已经是转过的这个。所以放在 dist:mac 里而不是 CI 的单独一步——本机打包和 CI 出来的是同一种 dmg。
 *
 * 已经是 ULMO 的跳过（重复跑不会再转一遍）；只碰 package.json 版本号对应的那个 dmg，dist 里旧版本的不动。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const 根 = path.resolve(import.meta.dirname, "..");
const 版本 = JSON.parse(fs.readFileSync(path.join(根, "package.json"), "utf8")).version;
const dist = path.join(根, "dist");
const dmgs = fs.readdirSync(dist).filter((f) => f.endsWith(".dmg") && f.includes(`-${版本}-`));
if (dmgs.length === 0) throw new Error(`dist 里没有 ${版本} 的 dmg，electron-builder 那一步没出包？`);

const 格式 = (f) => /^Format: (\S+)/m.exec(execFileSync("hdiutil", ["imageinfo", f], { encoding: "utf8" }))?.[1];
const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

for (const 名 of dmgs) {
  const 原 = path.join(dist, 名);
  if (格式(原) === "ULMO") {
    console.log(`${名} 已经是 ULMO，跳过`);
    continue;
  }
  const 新 = 原.replace(/\.dmg$/, ".ulmo.dmg");
  fs.rmSync(新, { force: true });
  const 前 = fs.statSync(原).size;
  execFileSync("hdiutil", ["convert", 原, "-format", "ULMO", "-o", 新], { stdio: "inherit" });
  execFileSync("hdiutil", ["verify", 新], { stdio: "inherit" });
  if (格式(新) !== "ULMO") throw new Error(`${新} 转完不是 ULMO`);
  fs.renameSync(新, 原);
  // blockmap 是按转之前的 dmg 算的，留着只会对不上（我们不发它，删掉免得误用）
  fs.rmSync(`${原}.blockmap`, { force: true });
  console.log(`${名}：${MB(前)} → ${MB(fs.statSync(原).size)}（ULMO）`);
}
