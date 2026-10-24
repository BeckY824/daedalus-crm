#!/usr/bin/env node
/**
 * 差分比对：node tests/off-diff/compare.mjs <main 倒出来的.json> <这次改动倒出来的.json>
 *
 * 规矩（企业版开关关着时，和 main 逐字段一致）：
 *   - 两边都有的表、都有的列：每一行每个字段都要一样
 *   - 这次改动多出来的列（迁移加的）：只许全空，或者全是同一个默认值
 *   - 这次改动多出来的表：只许是空的；「关着也记、不显示」的表写在 允许有数 里
 *   - main 有、这次改动没有的表或列：不许（删列要另开 PR 说清）
 *   - 每一步操作的返回（成功 / 报错文案）要一字不差
 * 不一样就列出前 30 处，退出码 1。
 */
import { readFileSync } from "node:fs";

/** 关着也照记、界面不显示的表：行数和内容不比（main 上没有这张表） */
const 允许有数 = new Set(["CustomerOwnerLog"]);

const [甲路径, 乙路径] = process.argv.slice(2);
if (!甲路径 || !乙路径) {
  console.error("用法：node tests/off-diff/compare.mjs <main.json> <head.json>");
  process.exit(2);
}
const 甲 = JSON.parse(readFileSync(甲路径, "utf8"));
const 乙 = JSON.parse(readFileSync(乙路径, "utf8"));
const 错 = [];
const 记 = (s) => 错.push(s);
const 写 = (v) => JSON.stringify(v);

for (const t of Object.keys(甲.列)) {
  if (!乙.列[t]) { 记(`表 ${t}：main 有，这次没有`); continue; }
  const 少 = 甲.列[t].filter((c) => !乙.列[t].includes(c));
  if (少.length) 记(`表 ${t}：少了列 ${少.join("、")}`);
  const 多 = 乙.列[t].filter((c) => !甲.列[t].includes(c));
  for (const c of 多) {
    const 值们 = new Set(乙.表[t].map((r) => 写(r[c])));
    if (值们.size > 1) 记(`表 ${t} 新列 ${c}：关着时应当全空或同一个默认值，实际有 ${值们.size} 种：${[...值们].slice(0, 3).join(" / ")}`);
  }
  const 甲行 = 甲.表[t], 乙行 = 乙.表[t];
  if (甲行.length !== 乙行.length) 记(`表 ${t}：main ${甲行.length} 行，这次 ${乙行.length} 行`);
  for (let i = 0; i < Math.min(甲行.length, 乙行.length); i++) {
    for (const c of 甲.列[t]) {
      if (!乙.列[t].includes(c)) continue;
      if (写(甲行[i][c]) !== 写(乙行[i][c])) 记(`${t} 第 ${i + 1} 行 ${c}：main ${写(甲行[i][c])}，这次 ${写(乙行[i][c])}`);
    }
  }
}
for (const t of Object.keys(乙.列)) {
  if (甲.列[t] || 允许有数.has(t)) continue;
  if (乙.表[t].length) 记(`新表 ${t}：关着时应当一行不写，实际 ${乙.表[t].length} 行`);
}

const 甲步 = 甲.步, 乙步 = 乙.步;
if (甲步.length !== 乙步.length) 记(`操作步数：main ${甲步.length}，这次 ${乙步.length}`);
for (let i = 0; i < Math.min(甲步.length, 乙步.length); i++) {
  if (写(甲步[i]) !== 写(乙步[i])) {
    记(`第 ${i + 1} 步 ${甲步[i].谁} ${甲步[i].做}：\n    main ${写(甲步[i].回)}\n    这次 ${写(乙步[i].回)}`);
  }
}

const 行数 = Object.values(甲.表).reduce((n, rs) => n + rs.length, 0);
if (错.length) {
  console.error(`开关关着和 main 不一致，${错.length} 处（只列前 30）：`);
  for (const s of 错.slice(0, 30)) console.error("  - " + s);
  process.exit(1);
}
console.log(`一致：${甲步.length} 步操作、${Object.keys(甲.表).length} 张表 ${行数} 行逐字段相同`);
