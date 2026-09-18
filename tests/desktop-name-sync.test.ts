/**
 * **在设置里改过名字的人，重启之后必须还是那个名字。**
 *
 * 桌面端的名字有两个来源：云端账号（注册时填的）和「个人资料」（自己改的）。
 * 登录那条路和每次启动的 server-entry 都会把本机管理员「对成」云端账号——
 * 2026-09-18 之前那是无条件覆盖，于是改完名字、重新登录一次就被改回去了。
 *
 * 判断「改没改过」靠记账：上一次同步下来的云端名字记在 Setting 的 desktop.syncedName。
 * 这里钉两件事：记账的 key 三处一致；那段判断真的在 server-entry 里（它是裸 SQL，
 * 编译器看不见，改坏了不会报错，只会又一次把用户的名字吃掉）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 同步名字键 } from "@/lib/desktop/synced-name";

const 根 = path.resolve(__dirname, "..");
const entry = fs.readFileSync(path.join(根, "desktop/server-entry.js"), "utf8");
const 登录 = fs.readFileSync(path.join(根, "src/app/login/actions.ts"), "utf8");

describe("名字只在你没改过的时候才跟着云端走", () => {
  it("记账的 key 三处是同一个", () => {
    expect(同步名字键).toBe("desktop.syncedName");
    // server-entry 是裸 SQL，抄的是这个常量的值——抄错了本文件当场红
    expect(entry).toContain(`WHERE key = '${同步名字键}'`);
    expect(entry).toContain(`INSERT INTO Setting (key, value, updatedAt) VALUES ('${同步名字键}'`);
    expect(登录).toContain("同步名字键");
  });

  it("启动时先比对再决定写不写名字，不是无条件覆盖", () => {
    expect(entry).toMatch(/人改过[\s\S]{0,160}要写的名字/);
    // 覆盖的那一行必须用「要写的名字」，不能再用云端那个
    expect(entry).not.toMatch(/UPDATE User SET email = \?, name = \?[^\n]*\.run\(联系, 名字,/);
    expect(entry).toMatch(/\.run\(联系, 要写的名字,/);
  });

  it("登录那条路同样先问过再写", () => {
    expect(登录).toMatch(/const 名字 = await 该用的名字\(admin\.name, 云端名字\)/);
    expect(登录).toMatch(/人改过 \? 本机名字 : 云端名字/);
  });

  it("登录邮箱不在保护之列——那是账号的身份，一直对着云端", () => {
    expect(entry).toMatch(/admin\.email !== 联系/);
  });
});
