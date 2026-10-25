/**
 * 企业版压测用的数据（10-24 结果：企业版 30 人 × 10 倍数据，主要页面 p95 < 200 ms）。
 *
 * 「1 倍」= 03-测试/性能基线.md 的那份：1 万客户、每人 2 条跟进、每 10 人 1 个商机（desktop/scripts/perf/seed.ts）。
 * 这里按 SCALE 倍造（默认 10 = 10 万客户 / 20 万跟进 / 1 万商机），分给 30 个人：1 管理员、3 主管、26 销售，
 * 每人名下的客户数一样多。另外照真团队的样子补：每 20 位客户 1 条待办、每 10 位 1 条跟进计划、每 50 位 1 张订单。
 *
 * 只写进 DATABASE_URL 指的那个库（enterprise-p95.mjs 新建的一次性库），不碰任何正式库。
 * 写完把每人名下几位客户的 id 存进 OUT（压测时打开客户详情用）。
 *   DATABASE_URL=file:<crm.db> SCALE=10 OUT=<people.json> npx tsx scripts/perf/enterprise-seed.ts
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "../../src/generated/prisma";

const p = new PrismaClient();
const SCALE = Number(process.env.SCALE ?? 10);
const N = Math.round(10_000 * SCALE);
const OUT = process.env.OUT ?? "people.json";
const 天 = 86_400_000;

const 姓 = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗";
const 名 = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "军", "洋", "勇", "艳", "杰", "娟", "涛", "明", "超", "秀英", "霞", "平"];
const 状态 = ["待跟进", "跟进中", "已成交", "已流失"];

async function main() {
  if ((await p.user.count()) > 0) throw new Error("库里已经有账号：这个脚本只往新建的空库里造");
  const 人们 = Array.from({ length: 30 }, (_, i) => ({
    id: `perf-u${String(i).padStart(2, "0")}`,
    email: `perf-u${String(i).padStart(2, "0")}@perf.local`,
    // 压测直接签会话票据，不走登录；这里放一个永远比对不上的值
    password: "!",
    name: `${姓[i % 20]}${名[(i * 3) % 20]}`,
    role: i === 0 ? "ADMIN" : i <= 3 ? "MANAGER" : "SALES",
    title: i === 0 ? "管理员" : i <= 3 ? "销售主管" : "销售",
  }));
  await p.user.createMany({ data: 人们 });
  const 现在 = Date.now();

  for (let b = 0; b < N; b += 1000) {
    const rows = [];
    for (let i = b; i < Math.min(N, b + 1000); i++) {
      rows.push({
        id: `perf-c${i}`,
        name: `${姓[i % 20]}${名[(i * 7) % 20]}（${i}号 某某贸易有限公司）`,
        phone: `138${String(10_000_000 + i).slice(-8)}`,
        salesOwnerId: 人们[i % 30].id,
        followStatus: 状态[i % 4],
        lastFollowAt: new Date(现在 - (i % 90) * 天),
        remark: i % 3 ? null : "老客户介绍，关注价格和交期，下个月再联系一次",
      });
    }
    await p.customer.createMany({ data: rows });
    const 本批 = rows.map((r) => ({ id: r.id, owner: r.salesOwnerId, i: Number(r.id.slice(6)) }));
    await p.followUp.createMany({
      data: 本批.flatMap((c) => [0, 1].map((k) => ({ type: "PHONE", title: "电话回访", content: "聊了报价和交期，客户说下周给答复。", status: "已完成", customerId: c.id, ownerId: c.owner, occurredAt: new Date(现在 - ((c.i * 2 + k) % 2000) * 3_600_000) }))),
    });
    await p.opportunity.createMany({ data: 本批.filter((c) => c.i % 10 === 0).map((c) => ({ name: `年度采购 ${c.i}`, amount: 10_000 + c.i * 137, customerId: c.id, ownerId: c.owner })) });
    await p.task.createMany({ data: 本批.filter((c) => c.i % 20 === 0).map((c) => ({ title: `回访 ${c.i} 号客户确认报价`, dueAt: new Date(现在 + ((c.i % 30) - 10) * 天), customerId: c.id, ownerId: c.owner })) });
    await p.followPlan.createMany({ data: 本批.filter((c) => c.i % 10 === 5).map((c) => ({ subject: `催 ${c.i} 号客户回签 PI`, plannedAt: new Date(现在 + ((c.i % 20) - 5) * 天), method: "电话沟通", customerId: c.id, ownerId: c.owner })) });
    await p.tradeOrder.createMany({ data: 本批.filter((c) => c.i % 50 === 0).map((c) => ({ no: `PI-PERF-${c.i}`, amount: 50_000 + c.i, currency: "USD", payment: "T/T 30/70", customerId: c.id, ownerId: c.owner })) });
  }

  // 每人挑 5 位自己名下的客户，压测时打开详情页
  const 名单 = 人们.map((u, k) => ({ id: u.id, role: u.role, customers: [0, 1, 2, 3, 4].map((j) => `perf-c${k + 30 * ((j * 97 + 11) % Math.floor(N / 30))}`) }));
  writeFileSync(OUT, JSON.stringify(名单));
  console.log(JSON.stringify({ scale: SCALE, users: 人们.length, customers: await p.customer.count(), followUps: await p.followUp.count(), opportunities: await p.opportunity.count(), tasks: await p.task.count(), plans: await p.followPlan.count(), orders: await p.tradeOrder.count() }));
}

main().finally(() => p.$disconnect());
