/**
 * 性能测量用的数据：1 万客户、每人 2 条跟进、每 10 人 1 个商机。只写进 DATABASE_URL 指的那个库（measure.mjs 的独立数据根）。
 *   DATABASE_URL=file:<crm.db> npx tsx desktop/scripts/perf/seed.ts
 */
import { PrismaClient } from "../../../src/generated/prisma";

const p = new PrismaClient();
const 姓 = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗";
const 名 = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "军", "洋", "勇", "艳", "杰", "娟", "涛", "明", "超", "秀英", "霞", "平"];
const 状态 = ["待跟进", "跟进中", "已成交", "已流失"];
const N = 10_000;

async function main() {
  const owner = await p.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!owner) throw new Error("库里没有账号");
  for (let b = 0; b < N; b += 500) {
    const rows = [];
    for (let i = b; i < Math.min(N, b + 500); i++) {
      rows.push({
        name: `${姓[i % 20]}${名[(i * 7) % 20]}（${i}号 某某贸易有限公司）`,
        phone: `138${String(10_000_000 + i).slice(-8)}`,
        salesOwnerId: owner.id,
        followStatus: 状态[i % 4],
        remark: i % 3 ? null : "老客户介绍，关注价格和交期，下个月再联系一次",
      });
    }
    await p.customer.createMany({ data: rows });
  }
  const ids = (await p.customer.findMany({ select: { id: true } })).map((c) => c.id);
  for (let b = 0; b < ids.length; b += 500) {
    const chunk = ids.slice(b, b + 500);
    await p.followUp.createMany({
      data: chunk.flatMap((id, j) => [0, 1].map((k) => ({ type: "PHONE", title: "电话回访", content: "聊了报价和交期，客户说下周给答复。", customerId: id, ownerId: owner.id, occurredAt: new Date(Date.now() - (j * 2 + k) * 3_600_000) }))),
    });
    await p.opportunity.createMany({ data: chunk.filter((_, j) => j % 10 === 0).map((id, j) => ({ name: `年度采购 ${b + j}`, amount: 10_000 + j * 137, customerId: id, ownerId: owner.id })) });
  }
  console.log({ customers: await p.customer.count(), followUps: await p.followUp.count(), opps: await p.opportunity.count() });
}

main().finally(() => p.$disconnect());
