/**
 * 账号名单的一致性。
 *
 * 名单在三个地方各存了一份（首次初始化、清库重建、演示数据），
 * 加上 README 与 DEPLOY 里给人看的表格。改一处漏改另一处的后果是
 * 「文档上的账号登不进去」或者「重建之后名字变回旧的」——
 * 都是要等到有人试着登录才会发现。这里把它们钉在一起。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { USERS } from "../prisma/seed";

const ROOT = path.resolve(__dirname, "..");
const 读 = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("三份账号名单必须一致", () => {
  it("名单本身是合法的", () => {
    expect(USERS.length).toBeGreaterThan(0);
    expect(USERS.filter((u) => u.role === "ADMIN").length, "至少要有一个管理员").toBeGreaterThan(0);
    // 登录名不能重复，否则 upsert 会互相覆盖
    expect(new Set(USERS.map((u) => u.email)).size).toBe(USERS.length);
  });

  it("reset-data.mjs 的副本与 seed.ts 一致", () => {
    const s = 读("prisma/reset-data.mjs");
    for (const u of USERS) {
      expect(s, `reset-data.mjs 缺少账号 ${u.email}`).toContain(`"${u.email}"`);
      expect(s, `reset-data.mjs 里 ${u.email} 的姓名对不上`).toContain(`"${u.name}"`);
    }
  });

  it("seed-demo.ts 的副本与 seed.ts 一致", () => {
    const s = 读("prisma/seed-demo.ts");
    for (const u of USERS) {
      expect(s, `seed-demo.ts 缺少账号 ${u.email}`).toContain(`"${u.email}"`);
      expect(s, `seed-demo.ts 里 ${u.email} 的姓名对不上`).toContain(`"${u.name}"`);
    }
  });

  it("已经没有旧账号残留（customer / demo 邮箱）", () => {
    for (const p of ["prisma/seed.ts", "prisma/reset-data.mjs", "prisma/seed-demo.ts", "README.md", "DEPLOY.md"]) {
      const s = 读(p);
      expect(s, `${p} 里还留着旧的 demo 邮箱账号`).not.toMatch(/@demo\.com/);
      expect(s, `${p} 里还留着旧密码 Crm@2026`).not.toContain("Crm@2026");
    }
  });
});

describe("文档里的账号要和代码一致", () => {
  it("README 列全了三个账号", () => {
    for (const p of ["README.md"]) {
      const s = 读(p);
      for (const u of USERS) {
        expect(s, `${p} 没有列出账号 ${u.email}`).toContain(u.email);
        expect(s, `${p} 没有列出 ${u.email} 的姓名 ${u.name}`).toContain(u.name);
      }
    }
  });

  it("开发文档里写的初始密码和代码里的默认值一致（生产不允许默认密码，由 entrypoint 拦）", () => {
    const 默认密码 = 读("prisma/seed.ts").match(/INIT_PASSWORD \?\? "([^"]+)"/)?.[1];
    expect(默认密码, "seed.ts 里读不到默认密码").toBeTruthy();
    for (const p of ["README.md"]) {
      expect(读(p), `${p} 里的初始密码和代码对不上`).toContain(默认密码!);
    }
  });
});
