/**
 * 企业版私有部署包（deploy/enterprise）的几条硬要求，读文件就能钉住，不用起 Docker（2026-10-24）。
 * 真起一遍 compose 的验证在 .github/workflows/enterprise-deploy-verify.yml。
 *
 * - 容器里 CRM_ENTERPRISE=1：漏了企业版功能整个不在，界面不报错，只是静悄悄地没了
 * - 不把 PRUNE_ACCOUNTS / RESET_PASSWORDS 映射进容器：企业的成员都是界面上加的，seed 不该碰
 * - 首启只建 admin，名单外（界面上加的）账号不提示、不删
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { USERS, 要建的账号 } from "../prisma/seed";

const ROOT = path.resolve(__dirname, "..");
const 读 = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const compose = 读("deploy/enterprise/docker-compose.yml");

/** crm 服务 environment: 底下的键值（只认这一段，caddy 的不算） */
function crm环境(): Map<string, string> {
  const m = new Map<string, string>();
  const crm段 = compose.split(/^ {2}caddy:/m)[0].split(/^ {2}crm:/m)[1] ?? "";
  let 在里面 = false;
  for (const 行 of crm段.split("\n")) {
    if (/^ {4}environment:\s*$/.test(行)) {
      在里面 = true;
      continue;
    }
    if (!在里面) continue;
    const k = 行.match(/^ {6}([A-Z][A-Z0-9_]+):\s*(.*)$/);
    if (k) m.set(k[1], k[2].trim());
    else if (/^ {0,4}\S/.test(行)) 在里面 = false;
  }
  return m;
}

describe("企业版 compose", () => {
  const env = crm环境();

  it("扫得到 crm 的环境变量（防止缩进或服务名改了以后整条测试变空）", () => {
    expect(env.size).toBeGreaterThan(3);
    expect(env.has("INIT_PASSWORD")).toBe(true);
  });

  it("CRM_ENTERPRISE 钉死为 \"1\"，不从 .env 取", () => {
    expect(env.get("CRM_ENTERPRISE")).toBe('"1"');
  });

  it("只经 HTTPS：COOKIE_SECURE 开着", () => {
    expect(env.get("COOKIE_SECURE")).toBe('"true"');
  });

  it("不把会删账号、重置密码的开关映射进容器", () => {
    for (const k of ["PRUNE_ACCOUNTS", "RESET_PASSWORDS", "MULTI_TENANT", "SHARED_WORKSPACE"]) expect(env.has(k), k).toBe(false);
  });

  it("镜像版本钉在 .env 的 CRM_VERSION，没有就起不来（不用 latest）", () => {
    expect(compose).toMatch(/image: "\$\{CRM_IMAGE:-[^}]+\}:\$\{CRM_VERSION:\?/);
  });
});

describe("首启建哪些账号", () => {
  it("企业版只建 admin；不是企业版照旧建整份名单", () => {
    expect(要建的账号(true).map((u) => u.email)).toEqual(["admin"]);
    expect(要建的账号(false)).toBe(USERS);
  });

  it("企业版跳过名单外账号那一段（界面上加的成员不提示、PRUNE_ACCOUNTS 也不删）", () => {
    expect(读("prisma/seed.ts")).toMatch(/const 名单外 = 企业版\(\) \? \[\] :/);
  });
});

describe("升级先在测试机验证", () => {
  const 验证 = 读("deploy/enterprise/tools/verify-upgrade.sh");
  const 打包 = 读("deploy/enterprise/tools/pack.sh");

  it("验证脚本调的是客户手里同一套 upgrade.sh / rollback.sh，不另写升级逻辑", () => {
    expect(验证).toMatch(/scripts\/upgrade\.sh/);
    expect(验证).toMatch(/scripts\/rollback\.sh/);
    expect(验证).not.toMatch(/docker compose up/);
  });

  it("我方的 tools/ 不进给客户的交付包", () => {
    expect(打包).not.toMatch(/\$HERE\/tools/);
    expect(打包).toMatch(/cp -R "\$HERE\/scripts"/);
  });

  it("CI 从已发布的版本升到这次的代码，再验自动退回", () => {
    const ci = 读(".github/workflows/enterprise-deploy-verify.yml");
    expect(ci).toMatch(/tools\/verify-upgrade\.sh --load/);
    expect(ci).toMatch(/UPGRADE_TIMEOUT=\d+ \.\/scripts\/upgrade\.sh/);
  });
});
