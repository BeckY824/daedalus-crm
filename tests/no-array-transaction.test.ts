/**
 * 守卫：业务库的 prisma 不许用数组式 `$transaction([...])`（2026-10-02 排查 A3）。
 *
 * 托管版的 prisma 是按工作区解析的代理（lib/prisma.ts）：模型方法一调就执行、返回原生 Promise，
 * 数组式 $transaction 收到它直接抛「All elements of the array need to be Prisma Client promises」——
 * 而数组里那几条已经写进去了。桌面端走直连客户端，跑不出这个错，所以单测和桌面端都看不见，
 * 一上网页端就是「停用同事卡住」「换负责人报错」「AI 对话存不下」。一律用函数式：$transaction(async (tx) => …)。
 * 控制面（control.$transaction）是普通客户端，不受影响。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function* 源文件(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "generated" || e.name === "node_modules") continue;
      yield* 源文件(p);
    } else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

describe("业务库不用数组式事务", () => {
  it("src 里没有 prisma.$transaction([", () => {
    const 犯 = [];
    for (const f of 源文件(path.resolve(__dirname, "../src"))) {
      const s = fs.readFileSync(f, "utf8");
      if (/(?<!control)\.\$transaction\(\s*\[/.test(s.replace(/control\.\$transaction\(\s*\[/g, ""))) 犯.push(path.relative(path.resolve(__dirname, ".."), f));
    }
    expect(犯).toEqual([]);
  });
});
