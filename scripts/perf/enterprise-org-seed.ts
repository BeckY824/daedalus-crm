/**
 * 企业版压测：在 enterprise-seed.ts 造好的库上再加一层组织架构，并打开「按组织架构看客户」（2026-10-26）。
 * 原来那些一行不改，只加：
 *   - 3 个部门，perf-u01–u03 各管一个（销售管理）
 *   - 26 个销售 perf-u04–u29 轮着挂到这三位下面（实线）；每 6 位里有一位另挂一位虚线上级（只能看）
 *   - 每 25 位客户有 1 位在公海（SCALE 10 = 4000 位）
 *   - 规则 按组织看客户 = 开
 * perf-u00 是管理员，照旧看全部，不进组织架构。造了什么并进 SEED 指的 seed.json（org: true）。
 *   DATABASE_URL=file:<crm.db> SEED=<seed.json> npx tsx scripts/perf/enterprise-org-seed.ts
 * 压测时：先用 enterprise-p95.mjs --extra 造一份库，再对那份库跑这个脚本，然后 enterprise-p95.mjs --extra --reuse-db --skip-build 照常量。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "../../src/generated/prisma";
import { 规则 } from "../../src/lib/enterprise/rules-table";

const p = new PrismaClient();
const SEED = process.env.SEED;
const 编号 = (i: number) => `perf-u${String(i).padStart(2, "0")}`;

async function main() {
  if (!SEED) throw new Error("要 SEED=<seed.json>");
  if ((await p.entMember.count()) > 0 || (await p.customerPool.count()) > 0) throw new Error("库里已经有组织架构或公海：这个脚本只加一次");
  const 经理们 = [1, 2, 3].map(编号);
  const 部门们 = [];
  for (const [k, 经理] of 经理们.entries()) {
    const d = await p.entDept.create({ data: { name: `销售${"一二三"[k]}部`, sort: k } });
    部门们.push(d.id);
    await p.entMember.create({ data: { userId: 经理, deptId: d.id, bizRole: "sales_mgr" } });
  }
  let 虚线 = 0;
  for (let i = 4; i < 30; i++) {
    const k = (i - 4) % 3;
    const 挂虚线 = i % 6 === 0;
    if (挂虚线) 虚线++;
    await p.entMember.create({ data: { userId: 编号(i), deptId: 部门们[k], bizRole: "sales", managerId: 经理们[k], dottedManagerId: 挂虚线 ? 经理们[(k + 1) % 3] : null } });
  }

  const 客户们 = await p.customer.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const 进公海 = 客户们.filter((_, i) => i % 25 === 0).map((c) => ({ customerId: c.id, reason: "自动" }));
  for (let i = 0; i < 进公海.length; i += 1000) await p.customerPool.createMany({ data: 进公海.slice(i, i + 1000) });

  await p.setting.upsert({ where: { key: 规则.按组织看客户.key }, update: { value: "true" }, create: { key: 规则.按组织看客户.key, value: "true" } });

  const 种子 = JSON.parse(readFileSync(SEED, "utf8"));
  writeFileSync(SEED, JSON.stringify({ ...种子, org: true, depts: 部门们.length, members: await p.entMember.count(), dotted: 虚线, pool: await p.customerPool.count() }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
