/**
 * 镜像构建的上下文排掉了 e2e/ 和 tests/（.dockerignore），但 tsconfig 会把 scripts/ 和 src/ 一起做类型检查。
 * 所以这两处只要有一行引了 e2e/ 或 tests/，本地全绿、Docker 里 `npm run build` 就报 TS2307——
 * v0.46.19 的服务器镜像就是这么挂的（scripts/research-bench.ts 引了 ../e2e/research-fake-llm）。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function 列文件(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? 列文件(p) : /\.(ts|tsx|mts|mjs|js)$/.test(n) ? [p] : [];
  });
}

describe("镜像里没有 e2e/、tests/，构建期的代码不能引它们", () => {
  it("scripts/ 和 src/ 里没有一处 import 指向 e2e/ 或 tests/", () => {
    const 引了 = /(?:from\s+|import\s*\(\s*)["'](?:\.\.\/)+(?:e2e|tests)\//;
    const 坏的 = ["scripts", "src"].flatMap(列文件).filter((f) => 引了.test(readFileSync(f, "utf8")));
    expect(坏的).toEqual([]);
  });
});
