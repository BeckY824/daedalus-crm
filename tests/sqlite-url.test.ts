/**
 * SQLite 只开 1 个连接（2026-10-05，见 src/lib/sqlite-url.ts）。
 * 多连接时交互式事务和别的写库在 Linux 上互相卡死（tests/stress.test.ts 在 CI 上整批「Socket timeout」）。
 * 这里钉两件：连接串怎么改；三个 PrismaClient 都走这个函数——以后新加一个客户端忘了，这条会红。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 单连接 } from "@/lib/sqlite-url";

describe("单连接", () => {
  it("file: 连接串加上 connection_limit=1；已经写了的原样；不是 file: 的不动", () => {
    expect(单连接("file:/data/crm.db")).toBe("file:/data/crm.db?connection_limit=1");
    expect(单连接("file:/a b/张 三/crm.db?socket_timeout=10")).toBe("file:/a b/张 三/crm.db?socket_timeout=10&connection_limit=1");
    expect(单连接("file:x.db?connection_limit=3")).toBe("file:x.db?connection_limit=3");
    expect(单连接(undefined)).toBeUndefined();
    expect(单连接("postgresql://x")).toBe("postgresql://x");
  });

  it("业务库、工作区库、控制面库三个客户端都走 单连接", () => {
    const 读 = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
    expect(读("src/lib/prisma.ts")).toMatch(/datasourceUrl:\s*单连接\(process\.env\.DATABASE_URL\)/);
    expect(读("src/lib/tenant/clients.ts")).toMatch(/url:\s*单连接\(`file:\$\{file\}`\)/);
    expect(读("src/lib/tenant/control.ts")).toMatch(/datasourceUrl:\s*单连接\(process\.env\.CONTROL_DATABASE_URL\)/);
    // 新加的 new PrismaClient 也要过这一道
    const 源码 = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "generated" ? [] : 源码(p);
        return /\.tsx?$/.test(e.name) ? [p] : [];
      });
    const 建客户端的 = 源码(path.resolve(__dirname, "../src")).filter((f) => /new PrismaClient\(/.test(fs.readFileSync(f, "utf8")));
    expect(建客户端的.map((f) => path.relative(path.resolve(__dirname, ".."), f).replaceAll("\\", "/")).sort()).toEqual(
      ["src/lib/prisma.ts", "src/lib/tenant/clients.ts", "src/lib/tenant/control.ts"],
    );
  });
});
