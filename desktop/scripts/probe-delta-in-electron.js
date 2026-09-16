#!/usr/bin/env node
/**
 * 在**真 Electron** 里跑一遍差量的「本地状态」，对着已装的包。
 *
 * 为什么要有它：Electron 给 fs 打了 asar 补丁，纯 Node 的单测发现不了它带来的差别
 * （0.24.2 真机首验：app.asar 被当成目录，遍历中断，只算到 264/2370 个文件，多下了 58 MB）。
 * 以后凡是改了碰应用包目录的 fs 代码，发版前跑一次：
 *
 *   cd desktop && node_modules/.bin/electron scripts/probe-delta-in-electron.js [/Applications/Daedalus\ CRM.app]
 *
 * 期望：两行文件数一样（补丁开着和 noAsar 一样多），且都等于包里真实文件数。
 */
const { app } = require("electron");
const path = require("path");
const delta = require(path.join(__dirname, "..", "delta.js"));

const bundle = process.argv[2] || "/Applications/Daedalus CRM.app";

app.whenReady().then(async () => {
  let 补丁开着, 关了;
  try {
    补丁开着 = (await delta.本地状态(bundle)).按路径.size;
  } catch (e) {
    补丁开着 = `抛了：${e.code} ${e.message.slice(0, 80)}`;
  }
  try {
    关了 = await delta.不管asar(async () => (await delta.本地状态(bundle)).按路径.size);
  } catch (e) {
    关了 = `抛了：${e.code} ${e.message.slice(0, 80)}`;
  }
  console.log(`本地状态（asar 补丁开着）：${补丁开着}`);
  console.log(`本地状态（noAsar）：${关了}`);
  const 对 = 补丁开着 === 关了 && typeof 关了 === "number" && 关了 > 1000;
  console.log(对 ? "✓ 一致" : "✗ 不一致——差量会把没算到的文件全重下");
  app.exit(对 ? 0 : 1);
});
