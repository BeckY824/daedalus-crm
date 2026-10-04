"use server";

import { 不在了 } from "@/lib/not-there";
import { 查完再写 } from "@/lib/check-then-write";
import { 钉住老签约 } from "@/lib/contract-owner";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { 看全部 } from "@/lib/team-scope";
import { requireUser } from "@/lib/auth";
import { resolveAttribution, wouldCreateCycle } from "@/lib/attribution";
import {
  conflictingFields,
  diffKeys,
  labelsOf,
  customerFieldLabels,
  REFERRER_KEYS,
  ATTRIBUTION_KEYS,
} from "@/lib/concurrency";
import { FOLLOW_STATUSES, DECISION_STATUSES, OPP_STAGES } from "@/lib/constants";
import { recordAudit, describeCustomerChanges } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";
import { getBusiness } from "@/lib/business";
import { 写签约金额, 带币种, 商机币种, 签约币种, 签约金额, 签约合计 } from "@/lib/money-db";
import { 金额 as 显示金额, 是币种, 规整币种 } from "@/lib/currency";
import { statusLabel } from "@/lib/business-config";
import { 查电话, 规整手机号, 认回打码号 } from "@/lib/phone";
import { 同号条件, 分机留存起 } from "@/lib/phone-dedupe";
import type { 带走数 } from "@/lib/carry-over";
import { 带走没做完的, 带走并记下, type 带走的 } from "@/lib/carry-over-db";
import { setOppStatus } from "../opportunities/actions";
import { completePlan, toggleTask } from "./[id]/actions";


/** 状态不在取值表里就给那句报错，合法给 null。建客户、批量改、撤销、行内改四处共用，报错文案一字不改 */
const 不合法 = (名: string, 表: readonly string[], v: unknown) => (表.includes(v as string) ? null : `${名}「${v}」不是合法取值`);
const 跟进不对 = (v: unknown) => 不合法("跟进状态", FOLLOW_STATUSES, v);
const 决策不对 = (v: unknown) => 不合法("决策状态", DECISION_STATUSES, v);

/** 是不是一位在职成员。各处下拉只列在职的；把客户交给停用的人等于丢进黑洞 */
async function 在职(id: string): Promise<boolean> {
  return Boolean((await prisma.user.findUnique({ where: { id }, select: { active: true } }))?.active);
}
export type CustomerInput = {
  id?: string;
  /**
   * 打开编辑框那一刻记录的版本号（即当时的 updatedAt）。
   * 保存时作为并发闸门：期间被别人改过就对不上，拒绝覆盖。新建时不需要。
   */
  updatedAt?: string | null;
  /**
   * 打开编辑框那一刻看到的一整份值。
   * 版本号对不上时靠它区分「对方改了什么」和「我改了什么」——
   * 两边没交集就直接合并，不该打扰用户。缺省时退回「一律拦下」的保守行为。
   */
  base?: CustomerSnapshot | null;
  name: string;
  phone: string;
  school: string | null;
  grade: string | null;
  major: string | null;
  followStatus: string;
  decisionStatus: string;
  expectedSignAt: Date | null;
  remark: string | null;
  /** 一个人的工作区里界面上不问这一项，留空由服务端填成那唯一的人 */
  salesOwnerId?: string | null;
  /** 推荐人二选一：外部渠道 或 已有学员 */
  channelId: string | null;
  referrerCustomerId: string | null;
  /**
   * 显式指定渠道负责人。undefined = 不碰（跟着推荐链走）；null = 清空后按推荐链重算；
   * 字符串 = 手工钉死为这个人。用于登记错误的单个订正，不影响任何其他学员。
   */
  channelOwnerId?: string | null;
};

/** 编辑框里可改的那部分字段，用作并发比对的基准快照 */
export type CustomerSnapshot = Pick<
  CustomerInput,
  | "name" | "phone" | "school" | "grade" | "major"
  | "followStatus" | "decisionStatus" | "expectedSignAt" | "remark"
  | "salesOwnerId" | "channelId" | "referrerCustomerId"
> & { channelOwnerId?: string | null };

export type DuplicateHit = {
  id: string;
  name: string;
  school: string | null;
  salesOwnerName: string;
  createdAt: string;
} | null;

/** 按手机号查重。手机号唯一性最可靠，姓名可能重名。和保存那一步一样先规整：「138 0000 1111」就是 13800001111 */
export async function checkDuplicate(phone: string, excludeId?: string): Promise<DuplicateHit> {
  await requireUser();
  const 号 = 规整手机号(phone);
  if (!号) return null;
  const 起 = await 分机留存起();
  // 看全部：团队版业务员录到同事已有的号码，也要提醒「这是谁的客户」（只给名字和负责人，打不开详情）
  const hit = await 看全部(() => prisma.customer.findFirst({
    where: { ...同号条件(号, 起), ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: {
      id: true,
      name: true,
      school: true,
      createdAt: true,
      salesOwner: { select: { name: true } },
    },
  }));
  if (!hit) return null;
  return {
    id: hit.id,
    name: hit.name,
    school: hit.school,
    salesOwnerName: hit.salesOwner.name,
    createdAt: hit.createdAt.toISOString(),
  };
}

/** 冲突时回传给界面，由界面负责按本地时区渲染时间 */
export type SaveConflict = {
  /** 库中这条记录当前的版本时间 */
  currentUpdatedAt: string;
  /** 真正撞车的字段：双方都改了同一项（中文名） */
  fields: string[];
  /** 对方这期间改过的全部字段，供用户判断要不要放弃自己的改动（中文名） */
  theirFields: string[];
};

export type SaveCustomerResult =
  | { ok: true; id: string; 带走?: 带走数 }
  | { ok: false; error: string; conflict?: SaveConflict };

export async function saveCustomer(input: CustomerInput): Promise<SaveCustomerResult> {
  const me = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!String(input.name ?? "").trim()) return { ok: false, error: "请填写姓名" };
  const b = await getBusiness();
  const labels = customerFieldLabels(b);

  const 改前 = input.id ? await prisma.customer.findUnique({ where: { id: input.id } }) : null;
  if (input.id && !改前) return { ok: false, error: `这条${b.customer}已经不在了（可能已删除），无法保存` };
  /*
    编辑之前先把老签约的「签约那一刻是谁的」钉住（排查 X1）。不只换负责人：改来源渠道 / 推荐人也会重算渠道负责人（复查 R）。
    没有缺的时候它只是一次很轻的查询，所以编辑一律先调，不去猜这次会不会动到归属
  */
  if (改前) await 钉住老签约();

  /*
    电话：和导入、表单同一条规矩（lib/phone.ts）。新建必填；编辑时原来有号码的不许清空，
    原来就没有的可以继续空着。**原样没动的号码不重新规整**——库里老数据的写法
    不该因为人改了一下备注就被悄悄换掉，留痕里平白多一条「手机号」。
  */
  // 共享区表单交回的是打码的样子：认回原号，当没改（排查 A2）
  const 原号 = String(认回打码号(input.phone, 改前?.phone) ?? "").trim();
  const 电话 = 改前 && 原号 === 改前.phone ? { ok: true as const, phone: 改前.phone } : 查电话(原号, { 必填: !改前 || Boolean(改前.phone) });
  if (!电话.ok) return { ok: false, error: 电话.error };
  const phone = 电话.phone;

  // 服务端再查一次重：表单上的提示只是给人看的，不能作为约束。
  // 空电话不查：两个都没留电话的人不是同一个人（原来这里会拿 "" 去比，没电话的人一个都存不了）
  if (phone) {
    const dup = await prisma.customer.findFirst({
      where: { ...同号条件(phone, await 分机留存起()), ...(input.id ? { id: { not: input.id } } : {}) },
      select: { name: true },
    });
    if (dup) return { ok: false, error: `手机号 ${phone} 已存在（${dup.name}），请勿重复录入` };
  }

  // 推荐链不能成环。只挡「推荐人是自己」不够：A→B→A 两步就能绕过去
  if (input.id && input.referrerCustomerId) {
    if (input.referrerCustomerId === input.id) {
      return { ok: false, error: "推荐人不能是本人" };
    }
    if (await wouldCreateCycle(input.id, input.referrerCustomerId)) {
      return {
        ok: false,
        error: `该${b.customer}已经在这位推荐人的上游，这样设置会让推荐链成环，归属无法计算`,
      };
    }
  }

  const 状态错 = 跟进不对(input.followStatus) ?? 决策不对(input.decisionStatus);
  if (状态错) return { ok: false, error: 状态错 };

  /**
   * 归属字段什么时候重算。
   *
   * 新建：按推荐链算。
   * 更新：**只在推荐链的输入（来源渠道 / 推荐人）变了才重算**，否则原样保留。
   * 原来每次保存都重算——去掉渠道级联之后，只要有人改一下备注，这里就会从
   * （已经换了人的）渠道重新算一遍，学员照样静默换主，等于级联从后门溜回来。
   * 规则和渠道那边一致：没动他的推荐链，他的归属就不动。
   */
  /*
    有推荐人时，channelId 是从推荐链顶端继承的派生值（attribution.ts），只比推荐人；
    表单在「已有客户」那一档不回传渠道，拿 null 去比库里的链顶渠道，会把没动的人判成「变了」。
  */
  const 推荐链变了 =
    !改前 ||
    (input.referrerCustomerId
      ? 改前.referrerCustomerId !== input.referrerCustomerId
      : 改前.referrerCustomerId !== null || 改前.channelId !== input.channelId);
  const attribution = 推荐链变了
    ? await resolveAttribution({ channelId: input.channelId, referrerCustomerId: input.referrerCustomerId })
    : {
        channelId: 改前!.channelId,
        attributionChannelId: 改前!.attributionChannelId,
        attributionCustomerId: 改前!.attributionCustomerId,
        channelOwnerId: 改前!.channelOwnerId,
      };
  // 显式指定压过推荐链：登记错误的单个订正走这里。null 表示清掉手工值、按推荐链重算
  if (input.channelOwnerId !== undefined) {
    if (input.channelOwnerId) {
      if (!(await 在职(input.channelOwnerId))) return { ok: false, error: "渠道负责人不存在或已停用" };
      attribution.channelOwnerId = input.channelOwnerId;
    } else {
      const 重算 = await resolveAttribution({ channelId: input.channelId, referrerCustomerId: input.referrerCustomerId });
      attribution.channelOwnerId = 重算.channelOwnerId;
    }
  }

  const salesOwnerId = input.salesOwnerId || (await 唯一负责人());
  if (!salesOwnerId) return { ok: false, error: "请选择销售负责人" };

  const data = {
    name: input.name.trim(),
    phone,
    school: input.school?.trim() || null,
    grade: input.grade || null,
    major: input.major?.trim() || null,
    followStatus: input.followStatus,
    decisionStatus: input.decisionStatus,
    expectedSignAt: input.expectedSignAt,
    remark: input.remark?.trim() || null,
    salesOwnerId,
    referrerCustomerId: input.referrerCustomerId,
    ...attribution,
  };

  if (!input.id) {
    /*
      上面那次查重和建档之间有缝：两个窗口同时点「保存」，两边都查不到对方、都建进去，同号两份档案。
      建档这一步在事务里再查一次（2026-10-04 J-104，lib/check-then-write.ts）。
      看全部：团队版业务员录到同事已有的号码也要挡，和线索转客户同一条（上面那次查重只看得到自己的）
    */
    const 起 = await 分机留存起();
    const 建了 = await 查完再写(async (tx) => {
      if (phone) {
        const dup = await 看全部(() => tx.customer.findFirst({ where: 同号条件(phone, 起), select: { name: true } }));
        if (dup) return { 撞号: dup.name } as const;
      }
      return { created: await tx.customer.create({ data }) } as const;
    });
    if ("撞号" in 建了) return { ok: false, error: `手机号 ${phone} 已存在（${建了.撞号}），请勿重复录入` };
    const { created } = 建了;
    await recordAudit({
      user: me, action: "create", entity: "Customer", entityId: created.id,
      summary: `新建${b.customer}「${created.name}」`,
    });
    revalidateCustomer();
    return { ok: true, id: created.id };
  }

  /** 记录这次改了哪几项、前后各是什么 */
  const 记一笔 = async (keys: string[], before: Record<string, unknown>, 合并 = false) => {
    if (!keys.length) return;
    await recordAudit({
      user: me, action: "update", entity: "Customer", entityId: input.id!,
      summary: `修改${b.customer}「${data.name}」：${keys.map((k) => labels[k] ?? k).join("、")}` +
        (合并 ? "（与他人的改动自动合并）" : ""),
      detail: describeCustomerChanges(keys, before, data as Record<string, unknown>, labels),
    });
  };

  /**
   * 乐观锁：把打开表单那一刻的 updatedAt 也放进 where。
   * 期间有人改过这条记录，updatedAt 已经变了，匹配不到、影响 0 行，
   * 于是这次提交被拒绝而不是把对方的改动整体盖掉。
   * 用 updateMany 而不是「先查再比再写」，是为了让判断和写入落在同一条语句里，
   * 中间没有可以被插进来的窗口。
   */
  const expected = input.updatedAt ? new Date(input.updatedAt) : null;
  if (!expected || Number.isNaN(expected.getTime())) {
    return { ok: false, error: "缺少记录版本信息，请刷新页面后重新编辑" };
  }

  /**
   * 版本号必须严格递增。
   * updatedAt 只精确到毫秒，两次保存恰好落在同一毫秒时它不会变，
   * 旧版本号会再次匹配成功，闸门就形同虚设了。
   * 用 max(now, 旧版本+1) 显式往前推一格，杜绝这种情况——
   * 闸门匹配成功即说明当前值就是 expected，所以这个新值一定更大。
   */
  const bump = (from: Date) => new Date(Math.max(Date.now(), from.getTime() + 1));

  // 留痕要对比前后值；改前 在上面算归属时已经取过一份
  const first = await prisma.customer.updateMany({
    where: { id: input.id, updatedAt: expected },
    data: { ...data, updatedAt: bump(expected) },
  });
  if (first.count === 1) {
    const 改前行 = 改前 as unknown as Record<string, unknown>;
    await 记一笔(diffKeys(改前行, data as Record<string, unknown>), 改前行);
    const 带走 = 改前 && 改前.salesOwnerId !== data.salesOwnerId
      ? await 带走没做完的([{ customerId: input.id, 旧: 改前.salesOwnerId }], data.salesOwnerId)
      : undefined;
    revalidateCustomer(input.id);
    return { ok: true, id: input.id, 带走 };
  }

  /**
   * 闸门没过，说明这期间有人动过这条记录。但「动过」不等于「撞车」——
   * 对方可能改的是别的字段，甚至只是给这个学员录了条跟进。
   * 拿 base 快照算清楚双方各改了什么，没交集就直接合并，别打扰用户。
   *
   * 循环是因为合并本身也要过闸门：极端情况下刚读完又被人改了，
   * 重来一次即可，几轮拿不下就老实报冲突。
   */
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.customer.findUnique({ where: { id: input.id } });
    if (!current) {
      return { ok: false, error: `这条${b.customer}已经不在了（可能已删除），无法保存` };
    }
    const currentRow = current as unknown as Record<string, unknown>;

    // 没有 base 就退回保守行为：只要库里现值和提交值对不上就拦
    if (!input.base) {
      const fields = conflictingFields(currentRow, data);
      return {
        ok: false,
        error: `这条${b.customer}在你打开编辑框之后又变过了，本次保存已取消`,
        conflict: { currentUpdatedAt: current.updatedAt.toISOString(), fields, theirFields: fields },
      };
    }

    // 共享区打开表单时看到的号码是打了码的：快照里的也认回原号，不然一碰上并发就误报「你们都改了手机号」（排查 A2）
    const baseRow = { ...input.base, phone: 认回打码号(input.base.phone, 改前?.phone) } as unknown as Record<string, unknown>;
    const theirs = diffKeys(baseRow, currentRow);
    const 改了推荐链 = diffKeys(baseRow, data).some((k) => (REFERRER_KEYS as readonly string[]).includes(k));
    /*
      渠道负责人是派生值：没动推荐链、也没单独订正时，data 里那一格是从库里现值抄来的（上面「原样保留」那支），
      拿它和 base 比会把同事刚改的值算成「我改的」，于是我只改备注也被判「两边都动了：渠道负责人」。
      只有我真动了它（显式订正 / 改推荐链连带重算）才算我的（2026-10-04 L-048）
    */
    const mine = diffKeys(baseRow, data).filter(
      (k) => k !== "channelOwnerId" || input.channelOwnerId !== undefined || 改了推荐链,
    );
    const overlap = mine.filter((k) => theirs.includes(k));

    if (overlap.length) {
      return {
        ok: false,
        error: `这条${b.customer}在你打开编辑框之后又变过了，本次保存已取消`,
        conflict: {
          currentUpdatedAt: current.updatedAt.toISOString(),
          fields: labelsOf(overlap),
          theirFields: labelsOf(theirs),
        },
      };
    }

    // 我什么都没改，写下去也是原样，直接当成功
    if (!mine.length) {
      return { ok: true, id: input.id };
    }

    // 只写我改动的那几个字段，对方改的原样保留
    const patch: Record<string, unknown> = {};
    for (const k of mine) patch[k] = (data as Record<string, unknown>)[k];
    // 推荐人一变，归属三件套要跟着走，不能只写推荐人本身
    if (mine.some((k) => (REFERRER_KEYS as readonly string[]).includes(k))) {
      for (const k of ATTRIBUTION_KEYS) patch[k] = (data as Record<string, unknown>)[k];
    }
    // 单独订正的渠道负责人不在 base 快照里，diffKeys 看不见它，要显式带上
    if (input.channelOwnerId !== undefined) patch.channelOwnerId = data.channelOwnerId;

    const merged = await prisma.customer.updateMany({
      where: { id: input.id, updatedAt: current.updatedAt },
      data: { ...patch, updatedAt: bump(current.updatedAt) },
    });
    if (merged.count === 1) {
      await 记一笔(mine, currentRow, true);
      const 带走 = mine.includes("salesOwnerId")
        ? await 带走没做完的([{ customerId: input.id, 旧: current.salesOwnerId }], data.salesOwnerId)
        : undefined;
      revalidateCustomer(input.id);
      return { ok: true, id: input.id, 带走 };
    }
  }

  return {
    ok: false,
    error: `这条${b.customer}正在被频繁修改，本次保存已取消，请刷新后重试`,
  };
}

function revalidateCustomer(id?: string) {
  revalidatePath("/customers");
  if (id) revalidatePath(`/customers/${id}`);
  revalidatePath("/dashboard");
}

export async function deleteCustomers(
  ids: string[],
): Promise<{ ok: true; deleted: number; 留下联系人: number } | { ok: false; error: string }> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, deleted: 0, 留下联系人: 0 };

  /**
   * 被别人当作推荐人或渠道归属对象的学员不能删。
   * Prisma 在自引用关系上默认 SetNull，直接删会把下游的推荐链和业绩归属
   * 静默置空——数据看着还在，归属已经没了，且不会有任何报错。
   */
  const referenced = await prisma.customer.findMany({
    where: {
      id: { in: ids },
      OR: [{ referrals: { some: {} } }, { attributedCustomers: { some: {} } }],
    },
    select: {
      name: true,
      _count: { select: { referrals: true, attributedCustomers: true } },
    },
  });
  if (referenced.length) {
    const detail = referenced
      .map((c) => `${c.name}（推荐了 ${c._count.referrals} 人，${c._count.attributedCustomers} 人的业绩归属于他）`)
      .join("、");
    return {
      ok: false,
      error: `以下${b.customer}是他人的推荐来源，删除会导致下游业绩归属丢失，已阻止：${detail}。如确需删除，请先调整下游${b.customer}的推荐人。`,
    };
  }

  // 删之前留个名字，删完就查不到了
  const 待删 = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, phone: true },
  });
  /*
    两个窗口几乎同时删同一位（或两批选中的有重叠）：两边都先读到了同一批联系人，后提交的那边在
    「搬进未归属」时撞上同一个 id（P2002），或删的时候那位已经没了——原来直接抛，界面上点了没反应（2026-10-04 第 2 期 2a）。
    整个事务回滚，什么都没写；按还在的那几位重来一次。一位都不在了就说一句
  */
  if (!待删.length) return { ok: false, error: `${ids.length > 1 ? "这几" : "这"}位${b.customer}已经在别处删掉了，刷新看看` };
  const 清点 = await 删除前清点(待删.map((c) => c.id));
  let 联系人: Awaited<ReturnType<typeof 搬走并删>>["联系人"] = [];
  let res: { count: number } = { count: 0 };
  for (let 第几次 = 0; ; 第几次++) {
    const 还在 = 第几次 === 0 ? 待删.map((c) => c.id) : (await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id);
    if (!还在.length) return { ok: false, error: `${ids.length > 1 ? "这几" : "这"}位${b.customer}已经在别处删掉了，刷新看看` };
    try {
      ({ 联系人, res } = await 搬走并删(还在));
      break;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (第几次 >= 2 || (code !== "P2002" && code !== "P2025")) throw e;
    }
  }
  if (res.count) {
    await recordAudit({
      user: me, action: "delete", entity: "Customer",
      entityId: 待删.length === 1 ? 待删[0].id : null,
      summary: `删除 ${res.count} 名${b.customer}：${待删.map((c) => c.name).join("、")}` +
        (联系人.length ? `（${联系人.length} 位联系人留在联系人页，未归属）` : ""),
      detail: { 客户: 待删, 一起删掉的: 清点 },
    });
  }
  revalidateCustomer();
  revalidatePath("/contacts");
  return { ok: true, deleted: res.count, 留下联系人: 联系人.length };
}

/**
 * 联系人搬进未归属、线索退回、删客户——一个事务。
 * 联系人不跟着删，搬进「未归属」（2026-10-02 排查 B1，和 0.46.14「只移出」同一个道理：
 * 人还是那个人，客户这条档案没了不等于这个人没了）。外键是级联删的，所以先搬再删、在同一个事务里。
 * 跟进记录随客户一起删，所以不记 followUpIds。
 */
async function 搬走并删(ids: string[]) {
  const 联系人 = await prisma.contact.findMany({
    where: { customerId: { in: ids } },
    include: { customer: { select: { name: true } } },
  });
  const res = await prisma.$transaction(async (tx) => {
    for (const c of 联系人) {
      await tx.unassignedContact.create({
        data: {
          id: c.id, name: c.name, position: c.position, phone: c.phone, email: c.email, wechat: c.wechat, remark: c.remark,
          fromCustomerId: c.customerId, fromCustomerName: c.customer.name, createdAt: c.createdAt,
        },
      });
    }
    /*
      从线索转来的客户删了，线索退回「跟进中」、转化时间清掉（2026-10-04 L-014）。
      外键会把 customerId 置空，但状态原来还挂「已转化」：列表上又出现「转客户」按钮，两样说法打架，
      编辑框的状态下拉也对不上；再转一次还会覆盖转化时间。退到「跟进中」：转过一次说明是跟过的，不是待跟进。
    */
    await tx.lead.updateMany({
      where: { customerId: { in: ids } },
      data: { customerId: null, status: "跟进中", convertedAt: null },
    });
    return tx.customer.deleteMany({ where: { id: { in: ids } } });
  });
  return { 联系人, res };
}

/** 删客户之前数一数：会一起删掉什么、什么会留下来。确认框照着它说，不再只写「跟进、待办与签约」 */
export type 删除清点 = {
  跟进: number;
  商机: number;
  计划和待办: number;
  签约: number;
  /** 按币种分开（2026-10-03，不换汇） */
  签约金额: { 币种: string; 合计: number }[];
  /** 联系人不删，搬进未归属 */
  联系人: number;
  /** 从线索转来的：线索还在，退回「跟进中」（L-014） */
  线索: number;
};

export async function 删除前清点(ids: string[]): Promise<删除清点> {
  await requireUser();
  const 在 = { customerId: { in: ids } };
  const [跟进, 商机, 计划, 待办, 签约, 联系人, 线索] = await Promise.all([
    prisma.followUp.count({ where: 在 }),
    prisma.opportunity.count({ where: 在 }),
    prisma.followPlan.count({ where: 在 }),
    prisma.task.count({ where: 在 }),
    prisma.contract.findMany({ where: 在, select: { amount: true, ...带币种.签约 } }),
    prisma.contact.count({ where: 在 }),
    prisma.lead.count({ where: 在 }),
  ]);
  return {
    跟进, 商机, 计划和待办: 计划 + 待办,
    签约: 签约.length, 签约金额: 签约合计(签约),
    联系人, 线索,
  };
}

/**
 * 批量操作只改一个字段，且是操作人明确勾了这些行、明确选了值，
 * 所以「最后写的赢」在语义上是对的，不套单条编辑那个版本号闸门——
 * 套了会让批量操作动不动就整批失败，反而没人敢用。
 *
 * 但不能静默：要如实回报实际改了几条。原本无论选中几条、
 * 实际命中几条，一律提示「已变更」，选错页、行已被别人删掉都看不出来。
 */
export type BulkResult =
  | {
      ok: true;
      /** 真正被改动的条数 */
      updated: number;
      /** 改负责人时跟着走的没做完的活（排查 B3） */
      带走?: 带走数;
      /** 跟着走的是哪几条：撤销只还这几条（T-018，见 撤销改负责人） */
      带过来?: 带走的;
      /**
       * 真被改动的那几条原来是什么值，给「撤销」用（排查 D1）。原来批量改完不能撤，
       * 留痕里也只记了新值，事后连手工恢复都做不到
       */
      原值?: { id: string; 值: string }[];
      /** 本来就是这个值、无需改动的条数 */
      unchanged: number;
      /** 选中但库里已经没有的条数（多半是被别人删了） */
      missing: number;
    }
  | { ok: false; error: string };

/** 批量改销售负责人 */
export async function assignSalesOwner(ids: string[], salesOwnerId: string): Promise<BulkResult> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, missing: 0 };

  if (!(await 在职(salesOwnerId))) return { ok: false, error: "该成员不存在或已停用，请选择一位在职成员" };

  // 本来就归他的不算「改动」，分开统计才对得上操作人看到的选中条数
  const already = await prisma.customer.count({ where: { id: { in: ids }, salesOwnerId } });
  await 钉住老签约();
  // 先记下每位原来归谁：他们没做完的活要跟着走（排查 B3）
  const 换人的 = await prisma.customer.findMany({
    where: { id: { in: ids }, salesOwnerId: { not: salesOwnerId } },
    select: { id: true, salesOwnerId: true },
  });
  const res = await prisma.customer.updateMany({
    where: { id: { in: ids }, salesOwnerId: { not: salesOwnerId } },
    data: { salesOwnerId },
  });
  const { 数: 带走, 记下: 带过来 } = await 带走并记下(换人的.map((c) => ({ customerId: c.id, 旧: c.salesOwnerId })), salesOwnerId);

  if (res.count) {
    await recordAudit({
      user: me, action: "assign", entity: "Customer",
      summary: `把 ${res.count} 名${b.customer}的销售负责人改为「${(await prisma.user.findUnique({ where: { id: salesOwnerId }, select: { name: true } }))?.name ?? salesOwnerId}」`,
      // 原值也记下：撤销提示条过了 6 秒，还能照着这里手工改回去（排查 D1）
      detail: { ids, salesOwnerId, 原负责人: 换人的.map((c) => ({ id: c.id, salesOwnerId: c.salesOwnerId })) },
    });
  }
  revalidateCustomer();
  return {
    ok: true, updated: res.count, unchanged: already, missing: ids.length - res.count - already, 带走, 带过来,
    原值: 换人的.map((c) => ({ id: c.id, 值: c.salesOwnerId })),
  };
}

/**
 * 撤销批量改负责人（2026-10-04 T-018）：负责人还给原来的人，**只还这次带过来的那几条活**（带过来）。
 * 原来撤销 = 反向再转一次，带走没做完的() 分不出「这次带过来的」和「新负责人本来就有的」，
 * 乙原本挂在这位客户上的待办、在谈商机也一起转给了甲——活悄悄换了人。和公海撤销领取（pool-actions 撤销公海）一个做法：
 *   - 只撤「现在还归新负责人」的：撤销之前又被人改给了别人的不动
 *   - 原负责人已经停用的不还（还给停用的人等于丢进黑洞），留在新负责人那儿
 *   - 带过来的活也只还「还挂在新负责人名下、还没做完」的
 * 看全部（团队版，lib/team-scope.ts）：业务员把自己的客户转给同事，客户一换人他就看不到了，限定着查撤不回来。
 * 所以要撤哪几位不靠限定定：要么是还给我自己（我刚转出去的），要么是我现在看得到的（公海里的）
 */
export async function 撤销改负责人(原值: { id: string; 值: string }[], 新负责人: string, 带过来?: 带走的): Promise<BulkResult> {
  const me = await requireUser();
  const b = await getBusiness();
  const ids = [...new Set(原值.map((x) => x.id))];
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, missing: 0 };
  const 看得到 = new Set((await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id));
  const 还归他 = new Set((await 看全部(() => prisma.customer.findMany({ where: { id: { in: ids }, salesOwnerId: 新负责人 }, select: { id: true } }))).map((c) => c.id));
  const 在职的 = new Set((await prisma.user.findMany({ where: { id: { in: 原值.map((x) => x.值) }, active: true }, select: { id: true } })).map((u) => u.id));
  const 退 = 原值.filter((x) => 还归他.has(x.id) && 在职的.has(x.值) && (x.值 === me.id || 看得到.has(x.id)));
  await 钉住老签约();
  const 退了: { id: string; salesOwnerId: string }[] = [];
  for (const x of 退) {
    const 成 = await 看全部(() => prisma.$transaction(async (tx) => {
      // 条件里再带一次新负责人：查完到这里之间被人改走了就不动
      const r = await tx.customer.updateMany({ where: { id: x.id, salesOwnerId: 新负责人 }, data: { salesOwnerId: x.值 } });
      if (!r.count) return false;
      if (带过来) {
        await tx.followPlan.updateMany({ where: { id: { in: 带过来.计划 }, customerId: x.id, ownerId: 新负责人, done: false }, data: { ownerId: x.值 } });
        await tx.task.updateMany({ where: { id: { in: 带过来.待办 }, customerId: x.id, ownerId: 新负责人, done: false }, data: { ownerId: x.值 } });
        await tx.opportunity.updateMany({ where: { id: { in: 带过来.商机 }, customerId: x.id, ownerId: 新负责人, status: "OPEN" }, data: { ownerId: x.值 } });
      }
      return true;
    }));
    if (成) 退了.push({ id: x.id, salesOwnerId: x.值 });
  }
  if (退了.length) {
    await recordAudit({
      user: me, action: "assign", entity: "Customer",
      summary: `撤销了刚才的批量分配：${退了.length} 名${b.customer}的销售负责人改回原来的人`,
      detail: { ids: 退了.map((x) => x.id), 从: 新负责人, 改回: 退了 },
    });
  }
  revalidateCustomer();
  return { ok: true, updated: 退了.length, unchanged: ids.length - 退了.length, missing: 0 };
}

export async function bulkFollowStatus(ids: string[], followStatus: string): Promise<BulkResult> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, missing: 0 };
  const 状态错 = 跟进不对(followStatus);
  if (状态错) return { ok: false, error: 状态错 };

  const already = await prisma.customer.count({ where: { id: { in: ids }, followStatus } });
  // 先记下每位原来的状态，给撤销用（排查 D1）
  const 要改的 = await prisma.customer.findMany({
    where: { id: { in: ids }, followStatus: { not: followStatus } },
    select: { id: true, followStatus: true },
  });
  const res = await prisma.customer.updateMany({
    where: { id: { in: 要改的.map((c) => c.id) }, followStatus: { not: followStatus } },
    data: { followStatus },
  });

  if (res.count) {
    await recordAudit({
      user: me, action: "assign", entity: "Customer",
      summary: `把 ${res.count} 名${b.customer}的跟进状态改为「${statusLabel(b, followStatus)}」`,
      detail: { ids, followStatus, 原状态: 要改的.map((c) => ({ id: c.id, followStatus: c.followStatus })) },
    });
  }
  revalidateCustomer();
  return {
    ok: true, updated: res.count, unchanged: already, missing: ids.length - res.count - already,
    原值: 要改的.map((c) => ({ id: c.id, 值: c.followStatus })),
  };
}

/* ---------- 签约 ---------- */

/** 命中查重时回传，供界面弹窗让人确认是不是真要再录一笔 */
export type ContractDuplicate = {
  amount: number;
  /** 币种（2026-10-03）：弹窗里按它显示金额 */
  currency: string;
  signedAt: string;
  remark: string | null;
};

export type SaveContractResult =
  | { ok: true; 联动?: 签约联动结果 }
  | { ok: false; error: string }
  | { ok: false; duplicate: ContractDuplicate };

/**
 * 登记签约时顺手收的尾：哪几个商机一起标赢单、哪几条计划 / 待办一起完成。
 *
 * 2026-09-28 审查 S3：签约和赢单原来是两条互不相通的线——签了 ¥86,000，
 * 商机还挂在「方案报价」、照样算进在谈金额；逾期计划也还在首页催你「先处理」
 * 一个已经签下来的人。弹窗里把这几样列出来、默认勾上，人可以取消勾选。
 * 服务端**只照勾选的做**，一项不勾就一项不动。
 */
export type 签约联动 = { 赢单: string[]; 完成计划: string[]; 完成待办: string[] };
export type 签约联动结果 = { 赢单: number; 完成计划: number; 完成待办: number };

/** 登记签约弹窗要列的东西：这位客户进行中的商机、没完成的计划和待办 */
export async function listContractLinks(customerId: string): Promise<{
  商机: { id: string; name: string; amount: number; stage: string; currency: string }[];
  计划: { id: string; subject: string; plannedAt: string }[];
  待办: { id: string; title: string; dueAt: string | null }[];
}> {
  await requireUser();
  const [商机, 计划, 待办] = await Promise.all([
    prisma.opportunity.findMany({ where: { customerId, status: "OPEN" }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, amount: true, stage: true, ...带币种.商机 } }),
    prisma.followPlan.findMany({ where: { customerId, done: false }, orderBy: { plannedAt: "asc" }, select: { id: true, subject: true, plannedAt: true } }),
    prisma.task.findMany({ where: { customerId, done: false }, orderBy: { dueAt: { sort: "asc", nulls: "last" } }, select: { id: true, title: true, dueAt: true } }),
  ]);
  return {
    商机: 商机.map(({ money: _m, ...o }) => ({ ...o, currency: 商机币种({ money: _m }) })),
    计划: 计划.map((x) => ({ ...x, plannedAt: x.plannedAt.toISOString() })),
    待办: 待办.map((x) => ({ ...x, dueAt: x.dueAt?.toISOString() ?? null })),
  };
}

/**
 * 登记签约。
 *
 * 查重规则（业务上定的）：同一学员 + 同一金额 + 同一天，视为可能是同一笔。
 * 两个人各录一次同一笔，业绩合计会翻倍且系统不会察觉——这是最难事后发现的一类。
 * 但续费和分期本来就可能同额同日，所以只弹窗确认，不硬拦：force 传 true 就照录。
 */
export async function saveContract(input: {
  id?: string;
  customerId: string;
  amount: number;
  signedAt: Date;
  remark: string | null;
  /** 币种（2026-10-03）。不给：新登记用本位币，编辑保持原来的 */
  currency?: string | null;
  /** 用户已在弹窗里确认「确实是另一笔」 */
  force?: boolean;
  /** 一起收尾的商机 / 计划 / 待办（弹窗里勾上的）。只在新登记时生效，编辑一笔旧签约不牵动别的 */
  联动?: 签约联动;
}): Promise<SaveContractResult> {
  try {
    const me = await requireUser();
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return { ok: false, error: "签约金额必须为正数" };
    }
    if (input.currency != null && !是币种(String(input.currency).toUpperCase())) return { ok: false, error: "不认识这个币种" };
    // 精确到分（外币常带小数）；Contract.amount 那一列是整数，照旧写四舍五入的值给老统计和导出用，精确值进 ContractMoney
    const 精确 = Math.round(input.amount * 100) / 100;
    if (精确 <= 0) return { ok: false as const, error: "签约金额必须大于 0" };
    const amount = Math.max(1, Math.round(精确));
    // 超过库里整数的上限（约 21 亿）：说一句，不让数据库抛（第二轮 r2-data）
    if (amount > 2_147_483_647) return { ok: false as const, error: "签约金额太大了，单笔最多 21 亿" };
  
    // 「同一天」按自然日算，不是 24 小时
    const dayStart = new Date(input.signedAt);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    // 事务里只用 tx（lib/check-then-write.ts），本位币先在外面读好
    const 本位币 = (await getBusiness()).currency;

    const data = {
      customerId: input.customerId,
      amount,
      signedAt: input.signedAt,
      remark: input.remark?.trim() || null,
    };
    const 学员 = await prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { name: true, salesOwnerId: true, channelOwnerId: true },
    });

    /*
      查重和落库在同一个事务里（2026-10-04 J-104）：原来两步分开，两个窗口同时点「登记」，
      两边都查不到对方、都写进去，业绩翻倍。现在后进来的那次查的时候前一笔已经在库里了，照样弹「可能重复」
    */
    const 落库 = await 查完再写(async (tx): Promise<{ duplicate: ContractDuplicate } | { 签约id: string; 币: string }> => {
      if (!input.force) {
        // 同额要连币种一起比：同一天 US$ 100 和 ¥ 100 不是同一笔
        const 原币 = input.id && input.currency == null ? await tx.contractMoney.findUnique({ where: { contractId: input.id }, select: { currency: true } }) : null;
        const 这笔币 = input.currency != null ? 规整币种(input.currency) : input.id ? 签约币种({ money: 原币 }) : 本位币;
        const 同日同额 = await tx.contract.findMany({
          where: {
            customerId: input.customerId,
            amount,
            signedAt: { gte: dayStart, lt: dayEnd },
            ...(input.id ? { id: { not: input.id } } : {}),
          },
          select: { amount: true, signedAt: true, remark: true, ...带币种.签约 },
        });
        const hit = 同日同额.find((c) => 签约币种(c) === 这笔币);
        if (hit) {
          return {
            duplicate: {
              amount: 签约金额(hit),
              currency: 签约币种(hit),
              signedAt: hit.signedAt.toISOString(),
              remark: hit.remark,
            },
          };
        }
      }

      let 签约id: string;
      let 币: string;
      if (input.id) {
        await tx.contract.update({ where: { id: input.id }, data });
        签约id = input.id;
        币 = input.currency ?? (await tx.contractMoney.findUnique({ where: { contractId: input.id } }))?.currency ?? "CNY";
      } else {
        // 记下签约这一刻是谁的单（排查 B2）。编辑旧签约不改它：那笔业绩当时是谁的就一直是谁的
        const c = await tx.contract.create({
          data: { ...data, owner: { create: { salesOwnerId: 学员?.salesOwnerId ?? null, channelOwnerId: 学员?.channelOwnerId ?? null } } },
        });
        签约id = c.id;
        币 = input.currency ?? 本位币;
      }
      // 编辑一笔老签约（没有 ContractMoney）也补上这一行：金额刚被重写过，精确值以这次为准
      await 写签约金额(tx, 签约id, 币, 精确);
      return { 签约id, 币 };
    });
    if ("duplicate" in 落库) return { ok: false, duplicate: 落库.duplicate };
    const { 签约id, 币 } = 落库;
  
    await recordAudit({
      user: me, action: input.id ? "update" : "create", entity: "Contract", entityId: 签约id,
      summary: `${input.id ? "修改" : "登记"}「${学员?.name ?? input.customerId}」的签约 ${显示金额(精确, 币)}` +
        (input.force ? "（已确认不是重复录入）" : ""),
      detail: { customerId: input.customerId, amount: 精确, currency: 币, signedAt: input.signedAt, force: !!input.force },
    });
  
    /*
      新登记一笔签约，把跟进状态推进到「已签约」，避免两处状态打架。
      **编辑一笔旧签约不碰状态**：退费后人工改成「已流失」的客户，改一下那笔签约的备注，
      原来会被硬改回「已签约 / 已决定报名」（2026-10-01 排查 A5）。
    */
    if (!input.id) {
      await prisma.customer.update({
        where: { id: input.customerId },
        data: { followStatus: "已签约", decisionStatus: "已决定报名" },
      });
    }
  
    const 联动 = !input.id && input.联动 && 签约id ? await 签约收尾(input.customerId, 签约id, input.联动) : undefined;
  
    revalidateCustomer(input.customerId);
    return { ok: true, ...(联动 ? { 联动 } : {}) };
  } catch (e) {
    return 不在了(e);
  }
}

/**
 * 照勾选把商机标赢单、计划和待办标完成。
 *
 * **每一样都走它原本的 action**（setOppStatus / completePlan / toggleTask），
 * 留痕、刷新各管各的——自己在这里另写一遍 update，日志里就少了「商机标记为赢单」
 * 那一条，而那正是事后回答「这单什么时候赢的」的唯一地方。
 * 只动属于这位客户、而且还没收尾的：id 是从浏览器来的，别人家的商机、已丢单的商机
 * 不该因为一次签约被改掉。
 */
async function 签约收尾(customerId: string, 签约id: string, 勾: 签约联动): Promise<签约联动结果> {
  const [商机, 计划, 待办] = await Promise.all([
    prisma.opportunity.findMany({ where: { id: { in: 勾.赢单 ?? [] }, customerId, status: "OPEN" }, select: { id: true, stage: true, probability: true } }),
    prisma.followPlan.findMany({ where: { id: { in: 勾.完成计划 ?? [] }, customerId, done: false }, select: { id: true } }),
    prisma.task.findMany({ where: { id: { in: 勾.完成待办 ?? [] }, customerId, done: false }, select: { id: true } }),
  ]);
  for (const o of 商机) {
    const r = await setOppStatus(o.id, "WON");
    // 记下是这笔签约赢下的、赢之前什么样（2026-10-04 L-007）：删这笔签约时据此退回，不然商机一直挂赢单、业绩虚高
    if (r.ok) {
      const 记 = { contractId: 签约id, prevStage: o.stage, prevProbability: o.probability };
      await prisma.contractWin.upsert({ where: { opportunityId: o.id }, create: { opportunityId: o.id, ...记 }, update: 记 });
    }
  }
  for (const p of 计划) await completePlan(p.id);
  for (const t of 待办) await toggleTask(t.id, true);
  return { 赢单: 商机.length, 完成计划: 计划.length, 完成待办: 待办.length };
}

/**
 * 删签约之前数一数：当初登记这笔时顺手标成赢单、现在还是赢单的商机有几个——删了会退回进行中（L-007）。
 * 确认框照着它说（第 2 期 2a：确认框说清会一起动什么）
 */
export async function 删签约前清点(id: string): Promise<{ 退回商机: string[] }> {
  await requireUser();
  const 赢下的 = await prisma.contractWin.findMany({
    where: { contractId: id, opportunity: { is: { status: "WON" } } },
    select: { opportunity: { select: { name: true } } },
  });
  return { 退回商机: 赢下的.map((w) => w.opportunity.name) };
}

/**
 * 删除签约记录。
 *
 * 删掉最后一笔后，学员的跟进状态会停在「已签约」但金额已归零，
 * 看板上就会长期挂着一条「已签约、金额 0」而没人提醒。
 * 退回到哪一档由界面弹窗让操作人自己选（也可以选择不动），系统不替人决定。
 */
export async function deleteContract(
  id: string,
  customerId: string,
  revertTo?: { followStatus: string; decisionStatus: string } | null,
): Promise<{ ok: true; remaining: number; 退回商机: number } | { ok: false; error: string }> {
  try {
    const me = await requireUser();
    const b = await getBusiness();
  
    if (revertTo) {
      const 状态错 = 跟进不对(revertTo.followStatus) ?? 决策不对(revertTo.decisionStatus);
      if (状态错) return { ok: false, error: 状态错 };
    }
  
    // 删完就查不到金额了，先留一份
    const 待删 = await prisma.contract.findUnique({ where: { id }, select: { amount: true, signedAt: true, ...带币种.签约 } });
    // 这笔签约顺手赢下的商机（2026-10-04 L-007）。签约一删这几行跟着级联没了，先取出来
    const 赢下的 = await prisma.contractWin.findMany({ where: { contractId: id }, include: { opportunity: { select: { status: true } } } });
    const gone = await prisma.contract.deleteMany({ where: { id, customerId } });
    if (gone.count === 0) {
      return { ok: false, error: "这条签约记录已经不在了（可能已删除）" };
    }
    /*
      退回签约前的阶段和概率（2026-10-04 L-007）。原来删签约不碰商机：签约没了、商机还挂赢单，本月赢单 / 漏斗 / 业绩一起虚高。
      只退「还是赢单」的：赢了之后离开过赢单的，ContractWin 那一行已经删了（opportunities/actions.ts 记结单）；
      这里再看一眼状态兜底——人改过的不许被盖掉。走 setOppStatus 的「还原」，留痕、结单时刻、刷新都在那里面。
      赢单前的阶段若是赢单成交（对齐之前的老数据），退到前一档，不能退出一张「进行中 + 赢单成交」的卡。
    */
    let 退回商机 = 0;
    for (const w of 赢下的) {
      if (w.opportunity.status !== "WON") continue;
      const 阶段 = w.prevStage === "赢单成交" || !OPP_STAGES.includes(w.prevStage as (typeof OPP_STAGES)[number]) ? "谈判审核" : w.prevStage;
      const r = await setOppStatus(w.opportunityId, "OPEN", { stage: 阶段, probability: w.prevProbability });
      if (r.ok) 退回商机++;
    }
  
    const remaining = await prisma.contract.count({ where: { customerId } });
    // 只在确实一笔不剩时才谈回退；还有别的签约就不该动状态
    if (revertTo && remaining === 0) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { followStatus: revertTo.followStatus, decisionStatus: revertTo.decisionStatus },
      });
    }
  
    await recordAudit({
      user: me, action: "delete", entity: "Contract", entityId: id,
      summary: `删除签约 ${待删 ? 显示金额(签约金额(待删), 签约币种(待删)) : 显示金额(0)}` +
        (revertTo && remaining === 0 ? `，跟进状态退回「${statusLabel(b, revertTo.followStatus)}」` : "") +
        (remaining ? `，该${b.customer}还剩 ${remaining} 笔` : "") +
        (退回商机 ? `，${退回商机} 个当初顺手标成赢单的商机退回进行中` : ""),
      detail: { customerId, amount: 待删?.amount, signedAt: 待删?.signedAt, revertTo, remaining, 退回商机 },
    });
  
    revalidateCustomer(customerId);
    return { ok: true, remaining, 退回商机 };
  } catch (e) {
    return 不在了(e);
  }
}

/* ---------- 记录页的行内编辑 ---------- */

/** 记录页里能直接点着改的字段。姓名、手机（要查重）、推荐关系（要重算归属）仍走完整表单 */
const PATCHABLE = ["school", "major", "grade", "remark", "expectedSignAt", "followStatus", "decisionStatus", "salesOwnerId", "channelOwnerId"] as const;
export type PatchableKey = (typeof PATCHABLE)[number];

/**
 * 只改一个字段。和 saveCustomer 的整表提交不同，单字段写入天然不会覆盖别人改的其它字段，
 * 所以不需要快照比对；留痕照记。
 */
export async function patchCustomer(id: string, key: PatchableKey, value: string | null): Promise<{ ok: true; 带走?: 带走数 } | { ok: false; error: string }> {
  const me = await requireUser();
  const b = await getBusiness();
  if (!PATCHABLE.includes(key)) return { ok: false, error: "这个字段不能在这里改" };
  // 动到归属的几格（负责人、渠道负责人、来源、推荐人）之前先钉住老签约（排查 X1 / 复查 R）
  if (["salesOwnerId", "channelOwnerId", "channelId", "referrerCustomerId"].includes(key)) await 钉住老签约();

  const v = typeof value === "string" ? value.trim() : value;
  const data: Record<string, unknown> = {};
  if (key === "followStatus") {
    const 错 = 跟进不对(v);
    if (错) return { ok: false, error: 错 };
    data.followStatus = v;
  } else if (key === "decisionStatus") {
    const 错 = 决策不对(v);
    if (错) return { ok: false, error: 错 };
    data.decisionStatus = v;
  } else if (key === "salesOwnerId") {
    if (typeof v !== "string" || !v || !(await 在职(v))) return { ok: false, error: "负责人不存在或已停用" };
    data.salesOwnerId = v;
  } else if (key === "channelOwnerId") {
    // 清空 = 恢复跟着推荐链走；给了人 = 手工钉死。只动这一条学员，不影响任何其他人
    if (v) {
      if (typeof v !== "string" || !(await 在职(v))) return { ok: false, error: "渠道负责人不存在或已停用" };
      data.channelOwnerId = v;
    } else {
      const cur = await prisma.customer.findUnique({ where: { id }, select: { channelId: true, referrerCustomerId: true } });
      if (!cur) return { ok: false, error: `这条${b.customer}已被删除` };
      data.channelOwnerId = (await resolveAttribution(cur)).channelOwnerId;
    }
  } else if (key === "expectedSignAt") {
    if (v && Number.isNaN(Date.parse(v))) return { ok: false, error: "日期格式不对" };
    data.expectedSignAt = v ? new Date(v) : null;
  } else {
    data[key] = v || null;
  }

  const before = await prisma.customer.findUnique({ where: { id }, select: { name: true, [key]: true } as never });
  if (!before) return { ok: false, error: `这条${b.customer}已被删除` };
  await prisma.customer.update({ where: { id }, data });
  const labels = customerFieldLabels(b);
  await recordAudit({
    user: me, action: "update", entity: "Customer", entityId: id,
    summary: `修改${b.customer}「${(before as { name: string }).name}」：${labels[key] ?? key}`,
    detail: describeCustomerChanges([key], before as Record<string, unknown>, data, labels),
  });
  // 换了销售负责人：原负责人在他身上没做完的活跟着走（排查 B3）
  const 原负责人 = (before as { salesOwnerId?: string }).salesOwnerId;
  const 带走 = key === "salesOwnerId" && 原负责人 && 原负责人 !== data.salesOwnerId
    ? await 带走没做完的([{ customerId: id, 旧: 原负责人 }], data.salesOwnerId as string)
    : undefined;
  revalidatePath(`/customers/${id}`);
  revalidatePath("/customers");
  return { ok: true, 带走 };
}
