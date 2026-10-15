/**
 * 手机端（浏览器）不能读 Prisma 的 DMMF，主键靠 scoped-pure.ts 里那张表——和 schema 对不上就收不了包。
 * 这里核：每张同步表都有、主键列和 DMMF 一致；手机端会碰到的模块不牵进 node: 模块。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Prisma } from "@/generated/prisma";
import { 同步表 } from "@/lib/sync/tables";
import { 主键表 } from "@/lib/sync/scoped-pure";

describe("手机端用的主键表", () => {
  it("和 schema 一致，同步表一张不少、一张不多", () => {
    const m = new Map(Prisma.dmmf.datamodel.models.map((x) => [x.name, x]));
    const 期望 = Object.fromEntries(同步表.map((t) => [t, m.get(t)!.fields.find((f) => f.isId)!.name]));
    expect(主键表).toEqual(期望);
  });
  it("手机端会打包的几个文件不 import node: 模块（浏览器里没有）", () => {
    for (const f of ["src/lib/sync/canon.ts", "src/lib/sync/crypto-web.ts", "src/lib/sync/scope-policy.ts", "src/lib/sync/scoped-pure.ts", "src/lib/sync/tables.ts", "src/lib/mobile/sync.ts"]) {
      const s = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
      const 非类型导入 = [...s.matchAll(/^import (?!type )[^;]*from "([^"]+)"/gm)].map((x) => x[1]);
      expect(非类型导入.filter((x) => x.startsWith("node:") || x.includes("generated/prisma") || x.endsWith("/local") || x.endsWith("/crypto") || x.endsWith("/scoped-local")), f).toEqual([]);
    }
  });
});
