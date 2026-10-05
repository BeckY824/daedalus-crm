"use server";

import { 外贸导入字段 } from "@/lib/import/fields";
import { 写外贸档案 } from "@/lib/customer-extra-db";

/**
 * 导入与撤销。
 *
 * 解析、映射、逐格校验全在 `lib/import/`（纯函数，不碰库），这里只做三件
 * 离不开数据库的事：**按手机号认人**、**把渠道名对成库里的渠道**、**落库并留痕**。
 *
 * 三条定死的规矩，都不是实现细节：
 *
 *   1. **认人只认手机号。** schema 里 `Customer.phone` 的注释就是「查重主键」，
 *      建档那条路本来就拒绝重复手机号。按姓名认人不做——重名就是把客户挂到别人名下，
 *      和归属规则里「绝不猜」是同一条。
 *   2. **重复的不覆盖，只补空。** 库里那格有值就一个字都不动。
 *      理由和「个人资料里改的名字不许被同步覆盖」是同一条：
 *      凡是人录过的东西，都不该被一份表刷掉。
 *   3. **一份表不改已有客户的归属。** 来源渠道只在**新建**那条路上生效。
 *      归属固化那条规则说「谁的数据没动，谁的归属就不变」，
 *      而补一格备注不该让一个人静默换主。
 */
import { revalidatePath } from "next/cache";
import { prisma, defaultClient } from "@/lib/prisma";
import { 看全部, 限定的我, 看得到 } from "@/lib/team-scope";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { resolveAttribution } from "@/lib/attribution";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";
import { 字段表, type 字段名 } from "@/lib/import/fields";
import { 摊开, 并重复行, 添行, type 排布 } from "@/lib/import/plan";
import { 认人表, 分机留存起, 同号条件, 这一批同号的 } from "@/lib/phone-dedupe";
import { 查完再写 } from "@/lib/check-then-write";

/** 一次导入最多落多少条。和 parse.ts 的行数上限一致，服务端再收一道 */
const 落库上限 = 10000;

export type 预览 = {
  新建: number;
  补空: number;
  跳过: number;
  /**
   * 库里已有、能认出是谁的几位，和库里同号多条、认不清的几位。补空 / 跳过 由它们按「重复行」的处置算出来——
   * 界面在第 4 步改处置时据此当场重算（import-steps 的 按处置），不用退回去再预览一次（2026-10-02 排查）
   */
  已在库里: number;
  说不清: number;
  进不了: number;
  /** 表里手机号重复、被合成一条的行数 */
  合掉几行: number;
  /** 有问题的格子，按「列 + 原值」归并——同一个写法改一次，整列一起生效 */
  待复核: { 列: number; 列名: string; 字段: 字段名; 原值: string; 说法: string; 严重: string; 几行: number }[];
  /** 进不了的那些行：行号 + 原因，最多列 20 条 */
  挡下: { 行号: number; 原因: string }[];
  /** 对不上任何字段的列名。按方案里的处置或并进备注、或丢掉 */
  没对上的列名: string[];
};

export type 导入方案 = Omit<排布, "字段表"> & {
  /** 手机号已经在库里的那些行怎么办 */
  重复行: "跳过" | "补空";
};

/** ImportRow.before 里记「补之前的 updatedAt」用的键。带 @ 的不是字段，撤销时不写回去（2026-10-04 J-052） */
const 写前键 = "@写前";

/** 补空时外贸档案那几格在 before 里的键前缀（撤销认它） */
const 档案前缀 = "extra.";

/** 「只补空字段」能碰的那几格。**故意不含推荐链和状态**，理由见文件头第 3 条。备注另有一条「添在后面」，见 执行导入 */
const 补空字段名单 = ["school", "grade", "major", "expectedSignAt", "remark"] as const;


async function 排好(方案: 导入方案) {
  const b = await getBusiness();
  const 表 = 字段表(b);
  // 来源渠道当场对库里的名单：对不上的预览里就标出来、原文并进备注，和落库是同一个结果
  const 用到渠道 = 方案.映射.includes("channelName");
  const 认得的渠道 = 用到渠道 ? new Set((await prisma.channel.findMany({ select: { name: true } })).map((c) => c.name)) : undefined;
  const rows = 摊开({ ...方案, 字段表: 表, 认得的渠道 });
  const { 行, 合掉几行 } = 并重复行(rows);
  return { b, 表, 行, 合掉几行 };
}

/**
 * 预览：这一份表导进去会发生什么。
 *
 * **这里算出来的数就是真正会发生的数**，不是估计。同一手机号的多行在
 * `并重复行` 里已经合过了，库里已有的那些在这儿真查了一遍。
 * Attio 的预览写的是「最多创建 X 条」，因为他们把合并留到执行时才做；
 * 人看到的数和事后的结果不一致，比数大一点更伤信任。
 */
export async function 预览导入(方案: 导入方案): Promise<{ ok: true; 预览: 预览 } | { ok: false; error: string }> {
  await requireUser();
  const { 行, 合掉几行 } = await 排好(方案);
  if (行.length > 落库上限) return { ok: false, error: `一次最多导 ${落库上限} 行，这份表有 ${行.length} 行` };

  // 带分机的号也认老库里只存了主号的那位，规矩见 lib/phone-dedupe 的 认人表（预览和执行同一张表，数才对得上）
  const 这一批 = 行.filter((r) => !r.进不了 && r.值.phone).map((r) => r.值.phone!);
  const 表 = 认人表(
    // 团队版业务员：同事的客户也要认出来（不然悄悄建出第二份），看全部
    await 看全部(async () => prisma.customer.findMany({ where: await 这一批同号的(prisma, 这一批), select: { phone: true, createdAt: true } })),
    这一批,
    await 分机留存起(),
  );

  let 新建 = 0;
  let 撞上 = 0;
  let 说不清 = 0;
  let 进不了 = 0;
  const 挡下: 预览["挡下"] = [];
  for (const r of 行) {
    if (r.进不了) {
      进不了++;
      if (挡下.length < 20) 挡下.push({ 行号: r.行号, 原因: r.进不了 });
      continue;
    }
    const { n, 说法 } = 表.认(r.值.phone!);
    if (n > 1) {
      说不清++;
      if (挡下.length < 20) 挡下.push({ 行号: r.行号, 原因: 说法 ?? `库里有 ${n} 位都是这个号码，不知道该算谁的` });
    } else if (n === 1) 撞上++;
    else 新建++;
  }

  // 有问题的格子按「列 + 原值」归并：一列里同一个写法出现三十行，人只该改一次
  const 归并 = new Map<string, 预览["待复核"][number]>();
  for (const r of 行) {
    for (const q of r.问题) {
      const k = `${q.列}|${q.原值}`;
      const 有 = 归并.get(k);
      if (有) 有.几行++;
      else
        归并.set(k, {
          列: q.列,
          列名: 方案.表头[q.列] ?? `第 ${q.列 + 1} 列`,
          字段: q.字段,
          原值: q.原值,
          说法: q.说法,
          严重: q.严重,
          几行: 1,
        });
    }
  }

  return {
    ok: true,
    预览: {
      新建,
      已在库里: 撞上,
      说不清,
      补空: 方案.重复行 === "补空" ? 撞上 : 0,
      // 库里同号多条的那些一律算跳过：不知道该算谁的，就谁也不动
      跳过: (方案.重复行 === "补空" ? 0 : 撞上) + 说不清,
      进不了,
      合掉几行,
      // 拦行的排最前：那几格是真的让人进不来的
      待复核: [...归并.values()].sort((a, c) => (a.严重 === c.严重 ? c.几行 - a.几行 : a.严重 === "拦行" ? -1 : 1)),
      挡下,
      // 没表头、数据里有值的列叫「第 N 列」，和 plan.ts 并进备注时写的出处一致（2026-10-04 J-056）
      没对上的列名: 方案.映射.flatMap((字段, 列) => {
        if (字段) return [];
        const h = (方案.表头[列] ?? "").trim();
        return h ? [h] : 方案.数据.some((r) => (r[列] ?? "").trim()) ? [`第 ${列 + 1} 列`] : [];
      }),
    },
  };
}

export type 导入结果 = { ok: true; batchId: string; 新建: number; 补空: number; 跳过: number; 进不了: number } | { ok: false; error: string };

/**
 * 真正落库。一个批次号，整批可撤销。
 *
 * **不放在一个大事务里。** 一万行一个事务在 SQLite 上会把写锁攥住好几秒，
 * 而桌面端那个库同一个进程里还有别的查询在跑。改成一条一条写、
 * 批次表先建好：中途失败的话，已经写进去的那些仍然挂在这个批次上，
 * 人照样能一键撤销——这比「要么全成要么全不成」更符合实际
 * （全不成的那一版里，失败发生在第 9000 行时人什么都拿不到）。
 */
export async function 执行导入(方案: 导入方案, fileName: string): Promise<导入结果> {
  const me = await requireUser();
  const { b, 行 } = await 排好(方案);
  if (行.length > 落库上限) return { ok: false, error: `一次最多导 ${落库上限} 行，这份表有 ${行.length} 行` };

  const salesOwnerId = await 唯一负责人() ?? me.id;

  // 渠道名 → id。对不上的在 排好 里已经留空、并进备注、预览里标过了
  const 渠道名单 = [...new Set(行.map((r) => r.值.channelName).filter(Boolean) as string[])];
  const 渠道 = new Map(
    (await prisma.channel.findMany({ where: { name: { in: 渠道名单 } }, select: { id: true, name: true } })).map((c) => [c.name, c.id]),
  );

  // 带分机的号也认老库里只存了主号的那位（第三轮 B4）；库里老写法「138 0000 1111」按号键认（R-067 / R-069，见 lib/phone-dedupe）
  const 这一批 = 行.filter((r) => !r.进不了 && r.值.phone).map((r) => r.值.phone!);
  /*
    团队版业务员（lib/team-scope.ts）：同号的人要看全部才认得出——同事的客户也算「已经有了」，不另建一份；
    但同事的客户不替他补空（业务员改不了别人的客户），算跳过
  */
  const 命中 = await 看全部(async () => prisma.customer.findMany({
    where: await 这一批同号的(prisma, 这一批),
    select: { id: true, phone: true, school: true, grade: true, major: true, expectedSignAt: true, remark: true, createdAt: true, updatedAt: true, salesOwnerId: true, channelOwnerId: true, pool: { select: { customerId: true } } },
  }));
  // 外贸档案（2026-10-05）在旁表里：补空也是「那一格空着才补」，先取一份现值
  const 档案们 = new Map(
    (await 看全部(async () => prisma.customerExtra.findMany({ where: { customerId: { in: 命中.map((c) => c.id) } } }))).map((x) => [x.customerId, x]),
  );
  const 限定我 = await 限定的我(defaultClient);
  const 表 = 认人表(命中, 这一批, await 分机留存起());

  const batch = await prisma.importBatch.create({
    data: { userId: me.id, userName: me.name, fileName: fileName.slice(0, 200), created: 0, updated: 0, skipped: 0, failed: 0 },
  });

  let 新建 = 0;
  let 补空 = 0;
  let 跳过 = 0;
  let 进不了 = 0;

  for (const r of 行) {
    if (r.进不了) {
      进不了++;
      continue;
    }
    const phone = r.值.phone!;
    /*
      库里同一个号码有两条：**谁也不动**。

      这套库刻意没给 phone 加唯一约束（家长和学生共用一个号码是真实场景，
      2026-08-29 决策）。于是「按手机号认人」在这一种情况下认不出人来，
      而随手挑一条去补，就是把一份表里的信息写到了另一个人的档案上。
      和归属那条规则同一个道理：重名不猜，同号也不猜。
    */
    const 认 = 表.认(phone);
    if (认.n > 1) {
      跳过++;
      continue;
    }
    const 旧 = 认.旧;

    if (旧 && !看得到(旧 as { salesOwnerId: string | null }, 限定我)) {
      跳过++;
      continue;
    }
    if (旧) {
      if (方案.重复行 !== "补空") {
        跳过++;
        continue;
      }
      const 补: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const k of 补空字段名单) {
        const 新值 = r.值[k as 字段名];
        if (!新值) continue;
        // 库里那格有值就一个字都不动——文件头第 2 条
        if ((旧 as Record<string, unknown>)[k] != null && (旧 as Record<string, unknown>)[k] !== "") continue;
        补[k] = k === "expectedSignAt" ? new Date(新值) : 新值;
        before[k] = (旧 as Record<string, unknown>)[k] ?? null;
      }
      /*
        库里备注有值：对上「备注」的那一列照旧不动，但表里我们没有的列（「微信号：…」）只有备注这一个去处——
        添在库里备注后面，原来的字一个不动、已经在里面的那行不重复添。原来这条路上整列丢，预览还说补空 0
        （2026-10-04 L-004 / J-051）。撤销照 before 把备注还原成原样
      */
      // 外贸档案：同一个规矩，库里那格空着才补。before 里记成「extra.国家键」，撤销时照它还原
      const 补档案: Partial<Record<(typeof 外贸导入字段)[number], string>> = {};
      for (const k of 外贸导入字段) {
        const 新值 = r.值[k];
        if (!新值 || 档案们.get(旧.id)?.[k]) continue;
        补档案[k] = 新值;
        before[`${档案前缀}${k}`] = null;
      }
      if (!("remark" in 补) && r.并进备注?.length && 旧.remark) {
        const 添后 = 添行(旧.remark, r.并进备注);
        if (添后 !== 旧.remark) {
          补.remark = 添后;
          before.remark = 旧.remark;
        }
      }
      if (Object.keys(补).length === 0 && Object.keys(补档案).length === 0) {
        跳过++;
        continue;
      }
      if (Object.keys(补档案).length) await 写外贸档案(prisma, 旧.id, 补档案);
      const 写后 = Object.keys(补).length
        ? await prisma.customer.update({ where: { id: 旧.id }, data: 补, select: { updatedAt: true } })
        : { updatedAt: 旧.updatedAt };
      /*
        「写前」= 补之前这位的 updatedAt。撤销这一批时拿它认出「补之前是谁写的最后一笔」——
        是另一批导入（先 A 建、再 B 补），撤完 B 就把 A 那条的指纹挪到新的 updatedAt 上，A 还撤得掉（2026-10-04 J-052）。
        塞在 before 里而不是加一列：不用为一个时刻动迁移；撤销只认 补空字段名单 里的键，不会把它当字段写回去
      */
      await prisma.importRow.create({
        data: { batchId: batch.id, customerId: 旧.id, kind: "update", before: JSON.stringify({ ...before, [写前键]: 旧.updatedAt.toISOString() }), writtenAt: 写后.updatedAt },
      });
      补空++;
      continue;
    }

    const channelId = r.值.channelName ? (渠道.get(r.值.channelName) ?? null) : null;
    const attribution = await resolveAttribution({ channelId, referrerCustomerId: null });
    try {
      /*
        建这一位和「号码还没人用」在同一个事务里再认一次（2026-10-04 J-104）：同一份表在两个窗口同时导，
        两边开头那次认人都查不到对方，原来各建一位。只比号键（不认老主号）——对方刚建的就是这个号码；带分机认老主号那套
        在开头的认人表里已经算过了。一行一个小事务，不攥着写锁不放（文件头「不放在一个大事务里」那条照旧）
      */
      const c = await 查完再写(async (tx) => {
        if (await 看全部(async () => tx.customer.findFirst({ where: await 同号条件(tx, phone, null), select: { id: true } }))) return null;
        const c = await tx.customer.create({
          data: {
            name: r.值.name!,
            phone,
            school: r.值.school ?? null,
            grade: r.值.grade ?? null,
            major: r.值.major ?? null,
            ...(r.值.followStatus ? { followStatus: r.值.followStatus } : {}),
            ...(r.值.decisionStatus ? { decisionStatus: r.值.decisionStatus } : {}),
            expectedSignAt: r.值.expectedSignAt ? new Date(r.值.expectedSignAt) : null,
            remark: r.值.remark ?? null,
            salesOwnerId,
            referrerCustomerId: null,
            ...attribution,
          },
        });
        await 写外贸档案(tx, c.id, Object.fromEntries(外贸导入字段.filter((k) => r.值[k]).map((k) => [k, r.值[k]!])));
        await tx.importRow.create({ data: { batchId: batch.id, customerId: c.id, kind: "create", writtenAt: c.updatedAt } });
        return c;
      });
      // 另一个窗口刚建了这个号码：算已在库里、跳过，不另建一份
      if (!c) {
        跳过++;
        continue;
      }
      新建++;
      // 同一份表里后面还有同号的行（并重复行已合过，这里是防御），别再建一条
      表.记下({ id: c.id, phone, school: c.school, grade: c.grade, major: c.major, expectedSignAt: c.expectedSignAt, remark: c.remark, createdAt: c.createdAt, updatedAt: c.updatedAt, salesOwnerId: c.salesOwnerId, channelOwnerId: c.channelOwnerId, pool: null });
    } catch {
      // 唯一约束、非法枚举之类：这一条不进，别把整批带下水
      进不了++;
    }
  }

  await prisma.importBatch.update({ where: { id: batch.id }, data: { created: 新建, updated: 补空, skipped: 跳过, failed: 进不了 } });
  await recordAudit({
    user: me,
    action: "import",
    entity: "Customer",
    entityId: batch.id,
    summary: `从「${fileName}」导入${b.customer}：新建 ${新建} 条，补空 ${补空} 条，跳过 ${跳过} 条，${进不了} 条没进来`,
    detail: { batchId: batch.id, fileName, 新建, 补空, 跳过, 进不了 },
  });
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { ok: true, batchId: batch.id, 新建, 补空, 跳过, 进不了 };
}

export type 批次 = {
  id: string;
  at: string;
  userName: string;
  fileName: string;
  created: number;
  updated: number;
  revertedAt: string | null;
};

/** 最近几批。设置页「数据」栏列它们，每批一颗撤销 */
export async function 最近批次(take = 10): Promise<批次[]> {
  await requireUser();
  const rows = await prisma.importBatch.findMany({ orderBy: { at: "desc" }, take });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    userName: r.userName,
    fileName: r.fileName,
    created: r.created,
    updated: r.updated,
    revertedAt: r.revertedAt?.toISOString() ?? null,
  }));
}

export type 撤销结果 =
  | { ok: true; 删掉: number; 还原: number; 没动: { name: string; 原因: string }[] }
  | { ok: false; error: string };

function 读批次(batchId: string) {
  return prisma.importBatch.findUnique({ where: { id: batchId }, include: { rows: true } });
}

/**
 * 撤销一整批。
 *
 * **导入之后被人动过的那条不碰**，并且如实说是哪几位、为什么。
 * 这是整个撤销里唯一需要拿主意的地方：一个人导进来之后马上跟了一通电话、
 * 记了一条跟进，这时候「撤销导入」如果把他连人带记录删掉，
 * 那撤销本身就成了第二次事故。判据有两条，任一成立就不动：
 *   - `updatedAt` 晚于这一批导入的时刻（有人改过他的档案）
 *   - 名下已经挂上了东西（跟进记录、商机、签约、联系人、任务、计划）
 *
 * 撤销自己也留痕。
 */
export async function 撤销批次(batchId: string): Promise<撤销结果> {
  const me = await requireUser();
  const b = await getBusiness();
  const batch = await 读批次(batchId);
  if (!batch) return { ok: false, error: "这一批导入记录已经不在了" };
  if (batch.revertedAt) return { ok: false, error: "这一批已经撤销过了" };
  /*
    先占住这一批再动手（2026-10-04 第 2 期 2a）：原来「撤销」连点两下，两边都过了上面那句检查、
    各撤一遍，后一下删同一位时抛 P2025（界面上没反应），还会留两条撤销痕。
    条件更新只有一边拿得到；中途出错把占位放回去，免得这一批卡在「撤过了」却没撤完
  */
  const 占到 = await prisma.importBatch.updateMany({ where: { id: batchId, revertedAt: null }, data: { revertedAt: new Date() } });
  if (占到.count === 0) return { ok: false, error: "这一批已经撤销过了" };
  try {
    return await 撤这一批(batch, me, b.customer);
  } catch (e) {
    await prisma.importBatch.updateMany({ where: { id: batchId }, data: { revertedAt: null } });
    throw e;
  }
}

async function 撤这一批(
  batch: NonNullable<Awaited<ReturnType<typeof 读批次>>>,
  me: Awaited<ReturnType<typeof requireUser>>,
  客户叫法: string,
): Promise<撤销结果> {
  const batchId = batch.id;
  let 删掉 = 0;
  let 还原 = 0;
  const 没动: { name: string; 原因: string }[] = [];

  for (const row of batch.rows) {
    const c = await prisma.customer.findUnique({
      where: { id: row.customerId },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        _count: { select: { followUps: true, opportunities: true, contracts: true, contacts: true, tasks: true, plans: true } },
        /*
          被别人当推荐人、或是别人的业绩归属对象：删掉他，下游那几位的推荐人和归属会被外键悄悄置空。
          手工删客户（deleteCustomers）早就拦了这种，撤销导入原来漏了（2026-10-01 排查 A7）
        */
        referrals: { select: { name: true }, take: 3 },
        attributedCustomers: { select: { name: true }, take: 3 },
      },
    });
    // 已经被删了：撤销的目的达到了，不算「没动」
    if (!c) continue;

    const 有挂件 = Object.values(c._count).some((n) => n > 0);
    const 下游 = [...new Set([...c.referrals, ...c.attributedCustomers].map((x) => x.name))];
    /*
      有 writtenAt 就精确比：写完那一刻的 updatedAt 和现在的不一样，就是之后有人改过。
      老批次没有，照旧按批次时刻 + 2 秒（毫秒级的相等不能当「改过」：建完马上写 ImportRow，只差几毫秒）
    */
    const 被改过 = row.writtenAt
      ? c.updatedAt.getTime() !== row.writtenAt.getTime()
      : c.updatedAt.getTime() - batch.at.getTime() > 2000;

    if (row.kind === "create") {
      if (下游.length) {
        没动.push({ name: c.name, 原因: `他是${下游.join("、")}的推荐人或业绩归属，删了他们的归属会断` });
        continue;
      }
      if (有挂件) {
        没动.push({ name: c.name, 原因: "名下已经有跟进记录或商机了" });
        continue;
      }
      if (被改过) {
        没动.push({ name: c.name, 原因: "导入之后又改过他的档案" });
        continue;
      }
      // 查完到删之间被手工删了也算撤到了（deleteMany 不抛）
      await prisma.customer.deleteMany({ where: { id: c.id } });
      删掉++;
      continue;
    }

    // update：把当时补进去的那几格还原成原来的样子（按定义全是空）
    if (被改过) {
      没动.push({ name: c.name, 原因: "导入之后又改过他的档案" });
      continue;
    }
    let before: Record<string, unknown> = {};
    try {
      before = JSON.parse(row.before ?? "{}") as Record<string, unknown>;
    } catch {
      没动.push({ name: c.name, 原因: "这条的原值读不出来了" });
      continue;
    }
    const data: Record<string, unknown> = {};
    const 档案还原: Record<string, null> = {};
    for (const [k, v] of Object.entries(before)) {
      // 外贸档案补过的格子（2026-10-05）：补之前按定义是空的，还原成空
      if (k.startsWith(档案前缀) && (外贸导入字段 as readonly string[]).includes(k.slice(档案前缀.length))) {
        档案还原[k.slice(档案前缀.length)] = null;
        continue;
      }
      // 只写回补空能碰的那几格：before 里还记着 写前键 这类不是字段的东西
      if (!(补空字段名单 as readonly string[]).includes(k)) continue;
      data[k] = k === "expectedSignAt" && v ? new Date(v as string) : (v ?? null);
    }
    if (Object.keys(档案还原).length) await 写外贸档案(prisma, c.id, 档案还原);
    if (Object.keys(data).length > 0) {
      const 撤后 = await prisma.customer.update({ where: { id: c.id }, data, select: { updatedAt: true } });
      /*
        倒着撤（先 A 建、再 B 补，撤 B 再撤 A）：撤 B 这一写改了 updatedAt，A 那条的 writtenAt 就对不上了，
        撤 A 时甲被当成「导入后改过」留下（2026-10-04 J-052）。
        B 补之前的那一刻若正是另一批（还没撤的）写完的那一刻，说明 A 和 B 之间没人动过他——撤完 B 他回到了 A 写完的样子，
        把那条的指纹挪到现在。A、B 之间有人手改过的，写前对不上任何一批，什么都不挪，照旧算改过
      */
      const 写前 = typeof before[写前键] === "string" ? new Date(before[写前键] as string) : null;
      if (写前 && !isNaN(写前.getTime())) {
        await prisma.importRow.updateMany({
          where: { customerId: c.id, writtenAt: 写前, batchId: { not: batchId }, batch: { is: { revertedAt: null } } },
          data: { writtenAt: 撤后.updatedAt },
        });
      }
    }
    还原++;
  }

  await recordAudit({
    user: me,
    action: "import-revert",
    entity: "Customer",
    entityId: batchId,
    summary: `撤销「${batch.fileName}」那一批导入：删掉 ${删掉} 位${客户叫法}，还原 ${还原} 条${没动.length ? `，${没动.length} 条因为导入后被动过而保留` : ""}`,
    detail: { batchId, 删掉, 还原, 没动 },
  });
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { ok: true, 删掉, 还原, 没动 };
}
