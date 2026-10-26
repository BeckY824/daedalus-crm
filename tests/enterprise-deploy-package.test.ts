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
const 读 = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replaceAll("\r\n", "\n"); // Windows 检出可能是 CRLF，下面的正则按 \n 写
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
    // 空库升级等于没验：CI 先灌演练数据；改了数据库结构也要跑
    expect(ci).toMatch(/FILL=1 \.\/tools\/verify-upgrade\.sh --load/);
    expect(ci).toMatch(/- "prisma\/\*\*"/);
  });

  it("每一步都核核心业务表的内容哈希，不只看行数；空库直接不验", () => {
    expect(验证).toMatch(/\$DRILL\/core-hash\.js/);
    expect(验证).toMatch(/\$DRILL\/fill\.js/);
    expect(验证).toMatch(/库是空的/);
    expect(验证).toMatch(/CORE_SKIP/);
  });
});

describe("备份真能恢复（恢复演练）", () => {
  const 演练 = 读("deploy/enterprise/tools/restore-drill.sh");
  const 恢复 = 读("deploy/enterprise/scripts/restore.sh");
  const 打包 = 读("deploy/enterprise/tools/pack.sh");
  const ci = 读(".github/workflows/enterprise-deploy-verify.yml");

  it("演练调的是客户手里同一套 backup.sh / restore.sh", () => {
    expect(演练).toMatch(/scripts\/backup\.sh/);
    expect(演练).toMatch(/scripts\/restore\.sh/);
    expect(演练).toMatch(/NO_START=1/);
  });

  it("五种坏备份都要被拒绝、数据不动", () => {
    for (const 坏 of ["截断一半", "中间改一个字节", "密码不对", "随机字节", "没有数据库的包"]) {
      expect(演练).toMatch(new RegExp(`refuse "${坏}"`));
    }
  });

  it("恢复前把整个压缩流读到底（只列目录发现不了后半截坏）", () => {
    expect(恢复).toMatch(/gzip -t/);
    expect(恢复).toMatch(/NO_START/);
  });

  it("CI 恢复演练跑三遍，一条命令安装且计时 30 分钟", () => {
    expect(ci).toMatch(/restore-drill:[\s\S]*round: \[1, 2, 3\]/);
    expect(ci).toMatch(/upgrade-drill:[\s\S]*round: \[1, 2, 3\]/);
    expect(ci).toMatch(/scripts\/install\.sh --domain localhost --load/);
    expect(ci).toMatch(/-lt 1800/);
    expect(ci).toMatch(/tools\/restore-drill\.sh --fill/);
  });

  it("CI 用这次打的镜像打交付包，不去拉 GHCR 上的同名版本", () => {
    expect(打包).toMatch(/LOCAL_APP_IMAGE/);
    expect(ci).toMatch(/LOCAL_APP_IMAGE=1 deploy\/enterprise\/tools\/pack\.sh/);
  });
});

describe("status.sh 的行家检查", () => {
  const 状态 = 读("deploy/enterprise/scripts/status.sh");

  it("磁盘：部署目录和 Docker 数据目录都看，85% 或剩不到 5G 提示", () => {
    expect(状态).toMatch(/DockerRootDir/);
    expect(状态).toMatch(/-ge 85/);
    expect(状态).toMatch(/-lt 5242880/);
  });

  it("证书：读正在用的那张，14 天内过期提示", () => {
    expect(状态).toMatch(/openssl s_client -connect 127\.0\.0\.1:443/);
    expect(状态).toMatch(/-checkend 1209600/);
  });

  it("时钟：没和时间服务器同步就提示", () => {
    expect(状态).toMatch(/NTPSynchronized/);
  });
});
