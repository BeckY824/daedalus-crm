/** npm run control:push 只放行本机开发库（scripts/control-push.mjs，回归核对 H-077） */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error 纯 JS 脚本，没有类型
import { 是本机开发库 } from "../scripts/control-push.mjs";

const ROOT = "/repo";
describe("control:push 门卫", () => {
  it("线上路径、没设、不是 SQLite 一律拒", () => {
    for (const u of ["file:/data/control.db", undefined, "", "postgres://x", "file:/var/lib/crm/control.db", "file:../../etc/control.db"]) {
      expect(是本机开发库(u, ROOT, "/tmpdir"), String(u)).toBe(false);
    }
  });
  it("仓库里、临时目录里的放行", () => {
    for (const u of ["file:./control.db", "file:/repo/prisma/control.db", "file:/tmpdir/x/control.db", "file:/tmp/control-ci.db"]) {
      expect(是本机开发库(u, ROOT, "/tmpdir"), u).toBe(true);
    }
  });
  it("package.json 的 control:push 走的是门卫，不是直接 prisma db push", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    expect(pkg.scripts["control:push"]).toBe("node scripts/control-push.mjs");
  });
});
