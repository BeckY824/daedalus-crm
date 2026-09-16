/**
 * 给网页那个共享工作区灌演示数据，也用来重置它。
 *
 * 网页版只有一个工作区，一套固定账号密码发给要试用的团队。它打开必须是有内容的——
 * 空列表比没有演示更劝退，人家点进来是想看这东西长什么样、能干什么，
 * 不是想看一个「暂无数据」。数据本身见 src/lib/shared-ws/dataset.ts。
 *
 * 用法（要带上托管版那套环境变量，容器里已经有）：
 *
 *   开发机： npx tsx scripts/seed-shared.ts [--reset]
 *   容器里： docker compose exec crm node seed-shared.js [--reset]
 *
 * 不带 --reset：库里已经有学员就什么都不做，免得重复灌成两份。
 * 带 --reset：先把库换成空模板再灌——试用的团队把数据改乱了就用它复原。
 *
 * **不碰控制面的到期日和付费态。** 老的演示区重置时会把工作区标成
 * ACTIVE + paidUntil 远期，那等于 AI 不限次；共享账号在多个团队手里，
 * 那就是把模型账单敞开。这个工作区靠 trialEndsAt 设在 2100 年永远可写，
 * AI 照常按账本限次，见 scripts/shared-workspace.ts。
 */
import fs from "node:fs";
import { control } from "@/lib/tenant/control";
import { workspaceClient, workspaceDbPath, dropWorkspaceClient } from "@/lib/tenant/clients";
import { templatePath } from "@/lib/tenant/workspaces";
import { 共享工作区slug } from "@/lib/shared-ws/config";
import { 灌演示数据 } from "@/lib/shared-ws/dataset";

async function main() {
  const slug = 共享工作区slug();
  if (!slug) {
    console.error("没配 SHARED_WORKSPACE，不知道要灌哪个工作区");
    process.exit(1);
  }
  const ws = await control.workspace.findUnique({ where: { slug } });
  if (!ws) {
    console.error(`控制面里没有 ${slug} 这个工作区。先跑 shared-workspace.ts 把它建出来`);
    process.exit(1);
  }
  const m = await control.membership.findFirst({ where: { workspaceId: ws.id, role: "OWNER" } });
  if (!m) {
    console.error("这个工作区没有 OWNER，控制面数据不一致，先查清楚再灌");
    process.exit(1);
  }

  const 重置 = process.argv.includes("--reset");
  if (重置) {
    const tpl = templatePath();
    if (!fs.existsSync(tpl)) {
      console.error(`模板库不存在：${tpl}`);
      process.exit(1);
    }
    /**
     * 必须先断开连接再换文件。反过来的话，那个还开着的连接握着旧 inode，
     * 之后的写会落到一个已经没人引用的文件里——表现是「重置成功但页面没变」，
     * 而且查不出原因。
     */
    await dropWorkspaceClient(ws.dbFile);
    const target = workspaceDbPath(ws.dbFile);
    for (const 后缀 of ["-wal", "-shm"]) fs.rmSync(`${target}${后缀}`, { force: true });
    fs.copyFileSync(tpl, target);
    console.log("库已经换成空模板");
  }

  const db = workspaceClient(ws.dbFile);
  const 已有 = await db.customer.count();
  if (已有 > 0) {
    console.log(`这个工作区已经有 ${已有} 位学员，不重复灌。要清空重来就加 --reset`);
    return;
  }

  // 重置之后库是空的，负责人要重新建；没重置的话用建工作区时那个
  let owner = await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!owner) {
    owner = await db.user.create({
      data: { email: `${slug}@workspace.local`, password: "!managed", name: "教务主任", role: "ADMIN", title: "教务主任" },
    });
    await db.workspaceAccount.create({ data: { userId: owner.id, accountId: m.accountId } });
  }

  const 条数 = await 灌演示数据(db, owner.id);
  console.log("灌好了：", Object.entries(条数).map(([k, v]) => `${k} ${v}`).join("，"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
