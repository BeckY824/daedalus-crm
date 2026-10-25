/**
 * 企业版压测用的数据（10-24 结果：企业版 30 人 × 10 倍数据，主要页面 p95 < 200 ms）。
 *
 * 「1 倍」= 03-测试/性能基线.md 的那份：1 万客户、每人 2 条跟进、每 10 人 1 个商机（desktop/scripts/perf/seed.ts）。
 * 这里按 SCALE 倍造（默认 10 = 10 万客户 / 20 万跟进 / 1 万商机），分给 30 个人：1 管理员、3 主管、26 销售，
 * 每人名下的客户数一样多。另外照真团队的样子补：每 20 位客户 1 条待办、每 10 位 1 条跟进计划、每 50 位 1 张订单。
 *
 * EXTRA=1 再加一组（2026-10-25，原来那些一行不改、照样先造，旧基线还能比）：
 *   - 逾期跟进计划：每 20 位客户 1 条（SCALE 10 = 5000 条），计划时间散在过去 1–30 天
 *   - 带节点的订单：每 100 位客户 1 张（SCALE 10 = 1000 张），每张 12 个节点都建上，
 *     进度从「刚确认」到「全走完」，5 种状态（未开始 / 进行中 / 已完成 / 卡住 / 不适用）都有，截止日有超期、3 天内到期、还早的
 *
 * 只写进 DATABASE_URL 指的那个库（enterprise-p95.mjs 新建的一次性库），不碰任何正式库。
 * 写完把每人名下几位客户的 id 存进 OUT（压测时打开客户详情用），造了什么写进 OUT 同目录的 seed.json。
 *   DATABASE_URL=file:<crm.db> SCALE=10 OUT=<people.json> [EXTRA=1] npx tsx scripts/perf/enterprise-seed.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PrismaClient } from "../../src/generated/prisma";
import { 节点名们 } from "../../src/lib/order";

const p = new PrismaClient();
const SCALE = Number(process.env.SCALE ?? 10);
const N = Math.round(10_000 * SCALE);
const OUT = process.env.OUT ?? "people.json";
const EXTRA = process.env.EXTRA === "1";
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

  if (EXTRA) await 加一组(人们, 现在);

  // 每人挑 5 位自己名下的客户，压测时打开详情页
  const 名单 = 人们.map((u, k) => ({ id: u.id, role: u.role, customers: [0, 1, 2, 3, 4].map((j) => `perf-c${k + 30 * ((j * 97 + 11) % Math.floor(N / 30))}`) }));
  writeFileSync(OUT, JSON.stringify(名单));
  const 造了 = { scale: SCALE, extra: EXTRA, users: 人们.length, customers: await p.customer.count(), followUps: await p.followUp.count(), opportunities: await p.opportunity.count(), tasks: await p.task.count(), plans: await p.followPlan.count(), orders: await p.tradeOrder.count(), orderNodes: await p.tradeOrderNode.count() };
  writeFileSync(join(dirname(OUT), "seed.json"), JSON.stringify(造了));
  console.log(JSON.stringify(造了));
}

/**
 * EXTRA=1：逾期跟进计划 + 带 12 个节点的订单。挂在原来的客户上，负责人跟客户走（客户 i 归第 i % 30 个人）。
 * 第 k 条挑哪位客户是算好的，30 个人都分得到，每人的逾期天数、节点进度也都是散开的
 */
async function 加一组(人们: { id: string }[], 现在: number) {
  const 批 = 1000;
  // 逾期跟进计划：第 k 条挂在客户 20k + k % 20 上；落在 1–30 天前，钟点也错开
  const 计划数 = Math.floor(N / 20);
  for (let b = 0; b < 计划数; b += 批) {
    await p.followPlan.createMany({
      data: Array.from({ length: Math.min(计划数, b + 批) - b }, (_, j) => {
        const k = b + j;
        const i = 20 * k + (k % 20);
        const 几天前 = 1 + ((k + Math.floor(k / 60)) % 30);
        return { subject: `跟进 ${i} 号客户样品反馈`, plannedAt: new Date(现在 - 几天前 * 天 - ((k * 7) % 24) * 3_600_000), method: "电话沟通", customerId: `perf-c${i}`, ownerId: 人们[i % 30].id };
      }),
    });
  }
  // 带节点的订单：第 k 张挂在客户 100k + k % 30 上
  const 订单数 = Math.floor(N / 100);
  for (let b = 0; b < 订单数; b += 批) {
    const 订单们 = Array.from({ length: Math.min(订单数, b + 批) - b }, (_, j) => {
      const k = b + j;
      const i = 100 * k + (k % 30);
      return { i, h: k + Math.floor(k / 30), owner: 人们[i % 30].id };
    });
    await p.tradeOrder.createMany({
      data: 订单们.map((c) => ({ id: `perf-o${c.i}`, no: `PI-PERF-N${c.i}`, amount: 30_000 + c.i, currency: c.h % 4 ? "USD" : "EUR", incoterm: c.h % 7 ? "FOB" : "EXW", payment: "T/T 30/70", depositDue: (30_000 + c.i) * 0.3, depositPaid: c.h % 3 ? (30_000 + c.i) * 0.3 : 0, customerId: `perf-c${c.i}`, ownerId: c.owner })),
    });
    // 节点：前 走完 个已完成（4–12），下一个进行中 / 卡住 / 未开始轮着来，EXW 不订舱（不适用）；
    // 截止日从「起」起每步 5 天，起 在过去 0–39 天：有超期的、3 天内到期的、还早的
    await p.tradeOrderNode.createMany({
      data: 订单们.flatMap((c) => {
        const 走完 = 4 + (c.h % 9);
        const 起 = 现在 - (c.h % 40) * 天;
        return 节点名们.map((name, n) => {
          const dueAt = new Date(起 + n * 5 * 天);
          const status = n < 走完 ? "已完成" : name === "订舱" && c.h % 7 === 0 ? "不适用" : n === 走完 ? ["进行中", "卡住", "未开始"][Math.floor(c.h / 9) % 3] : "未开始";
          return { orderId: `perf-o${c.i}`, idx: n + 1, name, dueAt, status, doneAt: status === "已完成" ? new Date(Math.min(dueAt.getTime(), 现在) - 3_600_000) : null };
        });
      }),
    });
  }
}

main().finally(() => p.$disconnect());
