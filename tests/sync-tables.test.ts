/**
 * 团队同步的三份清单和 schema 对得上（lib/sync/tables.ts）。漏了不会报错，只会悄悄不同步、或改身份漏改一列。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 同步表, 不同步表, 不同步列, 指向人的列, 同名合并 } from "@/lib/sync/tables";

const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
const 模型们 = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ 名: m[1], 体: m[2] }));

describe("团队同步清单", () => {
  it("schema 里每个模型不是同步就是明说不同步——新加的表不能没人管", () => {
    const 管了 = new Set<string>([...同步表, ...不同步表]);
    expect(模型们.length).toBeGreaterThan(20);
    expect(模型们.map((m) => m.名).filter((n) => !管了.has(n)), "新加的表要进 同步表 或 不同步表").toEqual([]);
    expect([...管了].filter((n) => !模型们.some((m) => m.名 === n)), "清单里有 schema 里已经没有的表").toEqual([]);
  });

  it("每一列指向人的列（有外键的、按名字认的）都在改身份的清单里", () => {
    const 应有: string[] = [];
    for (const m of 模型们) {
      if (m.名 === "User") continue;
      // 外键：`xxx User @relation(fields: [col], ...)`
      for (const r of m.体.matchAll(/^\s+\w+\s+User\??\s+@relation\([^)]*fields:\s*\[(\w+)\]/gm)) 应有.push(`${m.名}.${r[1]}`);
      // 没外键的：叫 ownerId / salesOwnerId / channelOwnerId / userId 的 String 列
      for (const r of m.体.matchAll(/^\s+((?:owner|salesOwner|channelOwner|user)Id)\s+String/gm)) 应有.push(`${m.名}.${r[1]}`);
    }
    const 有 = new Set(指向人的列.map(([t, c]) => `${t}.${c}`));
    expect([...new Set(应有)].filter((x) => !有.has(x)), "改身份会漏改这几列").toEqual([]);
    expect([...有].filter((x) => !应有.includes(x)), "清单里有 schema 里不存在的列").toEqual([]);
  });

  it("T-005 归属三件套不在不同步列里：保存那一刻固化的、不是派生字段，不同步的话各台业绩归属分叉、数据页对不上", () => {
    for (const c of ["attributionChannelId", "attributionCustomerId", "channelOwnerId"]) expect(不同步列.Customer ?? [], c).not.toContain(c);
  });

  it("不同步的列、同名合并的列在 schema 里都真有", () => {
    for (const [t, cs] of Object.entries(不同步列)) {
      const m = 模型们.find((x) => x.名 === t)!;
      for (const c of cs) expect(m.体, `${t}.${c}`).toMatch(new RegExp(`^\\s+${c}\\s`, "m"));
    }
    for (const [t, 规] of Object.entries(同名合并)) {
      expect(模型们.find((x) => x.名 === t)!.体).toMatch(new RegExp(`^\\s+${规.列}\\s+String\\s+@unique`, "m"));
    }
  });
});
