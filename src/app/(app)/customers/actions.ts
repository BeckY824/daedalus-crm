"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { resolveAttribution, wouldCreateCycle } from "@/lib/attribution";
import {
  conflictingFields,
  diffKeys,
  labelsOf,
  CUSTOMER_FIELD_LABELS,
  REFERRER_KEYS,
  ATTRIBUTION_KEYS,
} from "@/lib/concurrency";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "@/lib/constants";
import { recordAudit, describeCustomerChanges } from "@/lib/audit";

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
  salesOwnerId: string;
  /** 推荐人二选一：外部渠道 或 已有学员 */
  channelId: string | null;
  referrerCustomerId: string | null;
};

/** 编辑框里可改的那部分字段，用作并发比对的基准快照 */
export type CustomerSnapshot = Pick<
  CustomerInput,
  | "name" | "phone" | "school" | "grade" | "major"
  | "followStatus" | "decisionStatus" | "expectedSignAt" | "remark"
  | "salesOwnerId" | "channelId" | "referrerCustomerId"
>;

export type DuplicateHit = {
  id: string;
  name: string;
  school: string | null;
  salesOwnerName: string;
  createdAt: string;
} | null;

/** 按手机号查重。手机号唯一性最可靠，姓名可能重名 */
export async function checkDuplicate(phone: string, excludeId?: string): Promise<DuplicateHit> {
  await requireUser();
  const hit = await prisma.customer.findFirst({
    where: { phone: phone.trim(), ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: {
      id: true,
      name: true,
      school: true,
      createdAt: true,
      salesOwner: { select: { name: true } },
    },
  });
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
  | { ok: true; id: string }
  | { ok: false; error: string; conflict?: SaveConflict };

export async function saveCustomer(input: CustomerInput): Promise<SaveCustomerResult> {
  const me = await requireUser();
  const phone = input.phone.trim();

  // 服务端再查一次重：表单上的提示只是给人看的，不能作为约束
  const dup = await prisma.customer.findFirst({
    where: { phone, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { name: true },
  });
  if (dup) return { ok: false, error: `手机号 ${phone} 已存在（${dup.name}），请勿重复录入` };

  // 推荐链不能成环。只挡「推荐人是自己」不够：A→B→A 两步就能绕过去
  if (input.id && input.referrerCustomerId) {
    if (input.referrerCustomerId === input.id) {
      return { ok: false, error: "推荐人不能是本人" };
    }
    if (await wouldCreateCycle(input.id, input.referrerCustomerId)) {
      return {
        ok: false,
        error: "该学员已经在这位推荐人的上游，这样设置会让推荐链成环，归属无法计算",
      };
    }
  }

  if (!FOLLOW_STATUSES.includes(input.followStatus as (typeof FOLLOW_STATUSES)[number])) {
    return { ok: false, error: `跟进状态「${input.followStatus}」不是合法取值` };
  }
  if (!DECISION_STATUSES.includes(input.decisionStatus as (typeof DECISION_STATUSES)[number])) {
    return { ok: false, error: `决策状态「${input.decisionStatus}」不是合法取值` };
  }

  const attribution = await resolveAttribution({
    channelId: input.channelId,
    referrerCustomerId: input.referrerCustomerId,
  });

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
    salesOwnerId: input.salesOwnerId,
    referrerCustomerId: input.referrerCustomerId,
    ...attribution,
  };

  if (!input.id) {
    const created = await prisma.customer.create({ data });
    await recordAudit({
      user: me, action: "create", entity: "Customer", entityId: created.id,
      summary: `新建学员「${created.name}」`,
    });
    revalidatePath("/customers");
    revalidatePath("/dashboard");
    return { ok: true, id: created.id };
  }

  /** 记录这次改了哪几项、前后各是什么 */
  const 记一笔 = async (keys: string[], before: Record<string, unknown>, 合并 = false) => {
    if (!keys.length) return;
    await recordAudit({
      user: me, action: "update", entity: "Customer", entityId: input.id!,
      summary: `修改学员「${data.name}」：${keys.map((k) => CUSTOMER_FIELD_LABELS[k] ?? k).join("、")}` +
        (合并 ? "（与他人的改动自动合并）" : ""),
      detail: describeCustomerChanges(keys, before, data as Record<string, unknown>),
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

  // 留痕要对比前后值，所以写之前先取一份
  const 改前 = await prisma.customer.findUnique({ where: { id: input.id } });
  if (!改前) return { ok: false, error: "这条学员已被其他人删除，无法保存" };

  const first = await prisma.customer.updateMany({
    where: { id: input.id, updatedAt: expected },
    data: { ...data, updatedAt: bump(expected) },
  });
  if (first.count === 1) {
    const 改前行 = 改前 as unknown as Record<string, unknown>;
    await 记一笔(diffKeys(改前行, data as Record<string, unknown>), 改前行);
    revalidateCustomer(input.id);
    return { ok: true, id: input.id };
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
      return { ok: false, error: "这条学员已被其他人删除，无法保存" };
    }
    const currentRow = current as unknown as Record<string, unknown>;

    // 没有 base 就退回保守行为：只要库里现值和提交值对不上就拦
    if (!input.base) {
      const fields = conflictingFields(currentRow, data);
      return {
        ok: false,
        error: "这条学员在你编辑期间已被其他人修改，本次保存已取消",
        conflict: { currentUpdatedAt: current.updatedAt.toISOString(), fields, theirFields: fields },
      };
    }

    const baseRow = input.base as unknown as Record<string, unknown>;
    const theirs = diffKeys(baseRow, currentRow);
    const mine = diffKeys(baseRow, data);
    const overlap = mine.filter((k) => theirs.includes(k));

    if (overlap.length) {
      return {
        ok: false,
        error: "这条学员在你编辑期间已被其他人修改，本次保存已取消",
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

    const merged = await prisma.customer.updateMany({
      where: { id: input.id, updatedAt: current.updatedAt },
      data: { ...patch, updatedAt: bump(current.updatedAt) },
    });
    if (merged.count === 1) {
      await 记一笔(mine, currentRow, true);
      revalidateCustomer(input.id);
      return { ok: true, id: input.id };
    }
  }

  return {
    ok: false,
    error: "这条学员正在被频繁修改，本次保存已取消，请刷新后重试",
  };
}

function revalidateCustomer(id: string) {
  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  revalidatePath("/dashboard");
}

export async function deleteCustomers(
  ids: string[],
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const me = await requireUser();
  if (!ids.length) return { ok: true, deleted: 0 };

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
      error: `以下学员是他人的推荐来源，删除会导致下游业绩归属丢失，已阻止：${detail}。如确需删除，请先调整下游学员的推荐人。`,
    };
  }

  // 删之前留个名字，删完就查不到了
  const 待删 = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, phone: true },
  });
  const res = await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  if (res.count) {
    await recordAudit({
      user: me, action: "delete", entity: "Customer",
      entityId: 待删.length === 1 ? 待删[0].id : null,
      summary: `删除 ${res.count} 名学员：${待删.map((c) => c.name).join("、")}`,
      detail: 待删,
    });
  }
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { ok: true, deleted: res.count };
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
      /** 本来就是这个值、无需改动的条数 */
      unchanged: number;
      /** 选中但库里已经没有的条数（多半是被别人删了） */
      missing: number;
    }
  | { ok: false; error: string };

/** 批量改销售负责人 */
export async function assignSalesOwner(ids: string[], salesOwnerId: string): Promise<BulkResult> {
  const me = await requireUser();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, missing: 0 };

  // 转给一个已停用的人等于把这些学员丢进黑洞：各处下拉只列在职成员
  const owner = await prisma.user.findUnique({
    where: { id: salesOwnerId },
    select: { active: true },
  });
  if (!owner?.active) {
    return { ok: false, error: "该成员不存在或已停用，请选择一位在职成员" };
  }

  // 本来就归他的不算「改动」，分开统计才对得上操作人看到的选中条数
  const already = await prisma.customer.count({ where: { id: { in: ids }, salesOwnerId } });
  const res = await prisma.customer.updateMany({
    where: { id: { in: ids }, salesOwnerId: { not: salesOwnerId } },
    data: { salesOwnerId },
  });

  if (res.count) {
    await recordAudit({
      user: me, action: "assign", entity: "Customer",
      summary: `把 ${res.count} 名学员的销售负责人改为「${(await prisma.user.findUnique({ where: { id: salesOwnerId }, select: { name: true } }))?.name ?? salesOwnerId}」`,
      detail: { ids, salesOwnerId },
    });
  }
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { ok: true, updated: res.count, unchanged: already, missing: ids.length - res.count - already };
}

export async function bulkFollowStatus(ids: string[], followStatus: string): Promise<BulkResult> {
  const me = await requireUser();
  if (!ids.length) return { ok: true, updated: 0, unchanged: 0, missing: 0 };
  if (!FOLLOW_STATUSES.includes(followStatus as (typeof FOLLOW_STATUSES)[number])) {
    return { ok: false, error: `跟进状态「${followStatus}」不是合法取值` };
  }

  const already = await prisma.customer.count({ where: { id: { in: ids }, followStatus } });
  const res = await prisma.customer.updateMany({
    where: { id: { in: ids }, followStatus: { not: followStatus } },
    data: { followStatus },
  });

  if (res.count) {
    await recordAudit({
      user: me, action: "assign", entity: "Customer",
      summary: `把 ${res.count} 名学员的跟进状态改为「${followStatus}」`,
      detail: { ids, followStatus },
    });
  }
  revalidatePath("/customers");
  revalidatePath("/dashboard");
  return { ok: true, updated: res.count, unchanged: already, missing: ids.length - res.count - already };
}

/* ---------- 签约 ---------- */

/** 命中查重时回传，供界面弹窗让人确认是不是真要再录一笔 */
export type ContractDuplicate = {
  amount: number;
  signedAt: string;
  remark: string | null;
};

export type SaveContractResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; duplicate: ContractDuplicate };

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
  /** 用户已在弹窗里确认「确实是另一笔」 */
  force?: boolean;
}): Promise<SaveContractResult> {
  const me = await requireUser();
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: "签约金额必须为正数" };
  }
  const amount = Math.round(input.amount);

  if (!input.force) {
    // 「同一天」按自然日算，不是 24 小时
    const dayStart = new Date(input.signedAt);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const hit = await prisma.contract.findFirst({
      where: {
        customerId: input.customerId,
        amount,
        signedAt: { gte: dayStart, lt: dayEnd },
        ...(input.id ? { id: { not: input.id } } : {}),
      },
      select: { amount: true, signedAt: true, remark: true },
    });
    if (hit) {
      return {
        ok: false,
        duplicate: {
          amount: hit.amount,
          signedAt: hit.signedAt.toISOString(),
          remark: hit.remark,
        },
      };
    }
  }

  const data = {
    customerId: input.customerId,
    amount,
    signedAt: input.signedAt,
    remark: input.remark?.trim() || null,
  };
  const 学员 = await prisma.customer.findUnique({
    where: { id: input.customerId },
    select: { name: true },
  });
  if (input.id) await prisma.contract.update({ where: { id: input.id }, data });
  else await prisma.contract.create({ data });

  await recordAudit({
    user: me, action: input.id ? "update" : "create", entity: "Contract", entityId: input.id ?? null,
    summary: `${input.id ? "修改" : "登记"}「${学员?.name ?? input.customerId}」的签约 ¥${amount.toLocaleString("zh-CN")}` +
      (input.force ? "（已确认不是重复录入）" : ""),
    detail: { customerId: input.customerId, amount, signedAt: input.signedAt, force: !!input.force },
  });

  // 签约后把跟进状态推进到「已签约」，避免两处状态打架
  await prisma.customer.update({
    where: { id: input.customerId },
    data: { followStatus: "已签约", decisionStatus: "已决定报名" },
  });

  revalidateCustomer(input.customerId);
  return { ok: true };
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
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const me = await requireUser();

  if (revertTo) {
    if (!FOLLOW_STATUSES.includes(revertTo.followStatus as (typeof FOLLOW_STATUSES)[number])) {
      return { ok: false, error: `跟进状态「${revertTo.followStatus}」不是合法取值` };
    }
    if (!DECISION_STATUSES.includes(revertTo.decisionStatus as (typeof DECISION_STATUSES)[number])) {
      return { ok: false, error: `决策状态「${revertTo.decisionStatus}」不是合法取值` };
    }
  }

  // 删完就查不到金额了，先留一份
  const 待删 = await prisma.contract.findUnique({ where: { id }, select: { amount: true, signedAt: true } });
  const gone = await prisma.contract.deleteMany({ where: { id, customerId } });
  if (gone.count === 0) {
    return { ok: false, error: "这条签约记录已不存在，可能已被其他人删除" };
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
    summary: `删除签约 ¥${(待删?.amount ?? 0).toLocaleString("zh-CN")}` +
      (revertTo && remaining === 0 ? `，跟进状态退回「${revertTo.followStatus}」` : "") +
      (remaining ? `，该学员还剩 ${remaining} 笔` : ""),
    detail: { customerId, amount: 待删?.amount, signedAt: 待删?.signedAt, revertTo, remaining },
  });

  revalidateCustomer(customerId);
  return { ok: true, remaining };
}
