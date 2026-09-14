import fs from "node:fs";
import { control } from "@/lib/tenant/control";
import { workspaceClient, workspaceDbPath, workspaceDir, dropWorkspaceClient } from "@/lib/tenant/clients";
import { templatePath, slugify } from "@/lib/tenant/workspaces";
import { seedDemo, type DemoCounts } from "./dataset";
import { demoSlug } from "./config";

/**
 * 共享演示工作区。
 *
 * 和所有其他工作区最大的不同：**它是所有人共用的**。
 * 这在别处是事故，在这里成立，只因为里面一条真实信息都没有——
 * 全是编的学员和编的手机号。所以有两条规矩不能破：
 *
 *   1. 演示库只能由 seedDemo 生成，绝不从任何真实工作区拷数据
 *   2. 页面必须常驻提示，让人知道这里写什么都会被看到、而且每晚清掉
 *
 * 没配 DEMO_WORKSPACE 时整套东西不存在（自部署版就是这种情况）。
 */

/** 演示账号的登录标识。它是控制面里一个普通 Account，只是没人知道密码 */
const DEMO_EMAIL = "demo@ai-daedalus.com";

/** 演示工作区永不过期：到期只读的横条会盖掉演示提示，而且演示本来就不该催费 */
function 远期() {
  return new Date(Date.now() + 3650 * 86_400_000);
}

/**
 * 把一个空库填成演示库：建管理员、接上控制面账号、灌数据。
 * 建立和重置都走这里，两条路产出的库必须一模一样。
 */
async function 填充(dbFile: string, accountId: string): Promise<DemoCounts> {
  const db = workspaceClient(dbFile);
  const owner = await db.user.create({
    data: {
      email: DEMO_EMAIL,
      password: "!managed",
      name: "教务主任",
      role: "ADMIN",
      title: "教务主任",
    },
  });
  await db.workspaceAccount.create({ data: { userId: owner.id, accountId } });
  return seedDemo(db, owner.id);
}

/**
 * 确保演示工作区存在。已存在就原样返回，不动数据——
 * 重置是另一个动作，不能因为进程重启就把访客正在看的东西清掉。
 */
export async function 确保演示工作区(): Promise<{ slug: string; created: boolean; counts?: DemoCounts }> {
  const slug = demoSlug();
  if (!slug) throw new Error("没有配 DEMO_WORKSPACE");

  const 已有 = await control.workspace.findUnique({ where: { slug } });
  if (已有) return { slug, created: false };

  const tpl = templatePath();
  if (!fs.existsSync(tpl)) throw new Error(`模板库不存在：${tpl}`);

  // 演示账号：控制面里一个正常账号，密码存一个不可用的占位——
  // 进演示区只有 /demo 一条路，不经过密码校验
  const account =
    (await control.account.findFirst({ where: { email: DEMO_EMAIL } })) ??
    (await control.account.create({
      data: { email: DEMO_EMAIL, password: "!demo-no-login", name: "演示访客" },
    }));

  const dbFile = `${slug}.db`;
  const target = workspaceDbPath(dbFile);
  fs.mkdirSync(workspaceDir(), { recursive: true });
  fs.copyFileSync(tpl, target);

  try {
    const ws = await control.workspace.create({
      data: {
        slug,
        name: "启明国际教育（演示）",
        dbFile,
        status: "ACTIVE",
        trialEndsAt: 远期(),
        paidUntil: 远期(),
        note: "共享演示工作区，每晚重置",
      },
    });
    await control.membership.create({ data: { accountId: account.id, workspaceId: ws.id, role: "OWNER" } });
    const counts = await 填充(dbFile, account.id);
    return { slug, created: true, counts };
  } catch (e) {
    fs.rmSync(target, { force: true });
    for (const s of ["-wal", "-shm"]) fs.rmSync(`${target}${s}`, { force: true });
    throw e;
  }
}

/**
 * 重置演示工作区：把库文件换回模板，重新灌一遍。
 *
 * 必须先 dropWorkspaceClient 再换文件。反过来的话，那个还开着的连接
 * 握着旧 inode，之后的写会落到一个已经没人引用的文件里——
 * 表现是「重置成功但页面没变」，而且查不出原因。
 */
export async function 重置演示工作区(): Promise<DemoCounts> {
  const slug = demoSlug();
  if (!slug) throw new Error("没有配 DEMO_WORKSPACE");

  const ws = await control.workspace.findUnique({ where: { slug } });
  if (!ws) throw new Error("演示工作区还没建，先跑一次「确保」");

  const tpl = templatePath();
  if (!fs.existsSync(tpl)) throw new Error(`模板库不存在：${tpl}`);

  await dropWorkspaceClient(ws.dbFile);
  const target = workspaceDbPath(ws.dbFile);
  for (const s of ["-wal", "-shm"]) fs.rmSync(`${target}${s}`, { force: true });
  fs.copyFileSync(tpl, target);

  // 控制面的到期日也顺手推远：演示区跑了一年之后不该突然变只读
  await control.workspace.update({ where: { id: ws.id }, data: { trialEndsAt: 远期(), paidUntil: 远期(), status: "ACTIVE" } });

  const m = await control.membership.findFirst({ where: { workspaceId: ws.id, role: "OWNER" } });
  if (!m) throw new Error("演示工作区没有 OWNER，控制面数据不一致");
  return 填充(ws.dbFile, m.accountId);
}

/** 演示账号在控制面的 id 与工作区 id，/demo 签票据要用 */
export async function 演示票据信息(): Promise<{ accountId: string; workspaceId: string } | null> {
  const slug = demoSlug();
  if (!slug) return null;
  const ws = await control.workspace.findUnique({ where: { slug }, include: { memberships: true } });
  const m = ws?.memberships.find((x) => x.role === "OWNER");
  return ws && m ? { accountId: m.accountId, workspaceId: ws.id } : null;
}

export { slugify };
// 转出去，调用方不必关心这两个函数住在哪个文件
export { demoSlug, 是演示工作区 } from "./config";
