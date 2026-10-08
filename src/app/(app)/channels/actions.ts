"use server";

import { hasVisibleText } from "@/lib/form-validation";

import { 版本冲突, 版本条件 } from "@/lib/edit-version";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { 认回打码号 } from "@/lib/phone";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";
import { getBusiness } from "@/lib/business";
import { 不在了 } from "@/lib/not-there";

/**
 * 成功时回传渠道 id（新建是新 id，编辑是原 id）。
 * 「新建学员」里就地建渠道后要立刻把它选中，没有 id 就选不上。
 */
export async function saveChannel(input: {
  id?: string;
  name: string;
  phone: string | null;
  remark: string | null;
  /** 一个人的工作区里界面上不问这一项，留空由服务端填成那唯一的人 */
  channelOwnerId?: string | null;
  /** 打开编辑框那一刻的 updatedAt。给了就当闸门：期间有人改过不盖掉（排查 D3） */
  版本?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireUser();
  // 名字只有空格不收（第二轮 r2-data：原来存出一条没有名字的）
  if (!hasVisibleText(input.name)) return { ok: false, error: "请填写渠道名称" };
  const b = await getBusiness();
  const name = input.name.trim();
  const channelOwnerId = input.channelOwnerId || (await 唯一负责人());
  if (!channelOwnerId) return { ok: false, error: "请选择渠道负责人" };

  const dup = await prisma.channel.findFirst({
    where: { name, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true },
  });
  if (dup) return { ok: false, error: `渠道「${name}」已存在` };

  // 共享试用区的渠道页给的是打码号码：交回来的正是原号打码的样子就认回原号，别的带 * 的不收（2026-10-02 排查 A6）
  const 原号 = input.id ? (await prisma.channel.findUnique({ where: { id: input.id }, select: { phone: true } }))?.phone : null;
  const 号 = 认回打码号(input.phone?.trim() || null, 原号);
  if (号 && 号.includes("*")) return { ok: false, error: "电话里不能有 *" };
  const data = {
    name,
    phone: 号 || null,
    remark: input.remark?.trim() || null,
    channelOwnerId,
  };

  let 新建id: string | undefined;

  if (input.id) {
    const 改前 = await prisma.channel.findUnique({ where: { id: input.id }, select: { channelOwnerId: true } });
    if (!改前) return { ok: false, error: "这个渠道已经不在了（可能已删除）" };
    const 写了 = await prisma.channel.updateMany({ where: { id: input.id, ...版本条件(input.版本) }, data });
    if (写了.count === 0) return { ok: false, error: 版本冲突 };
    /**
     * 改渠道负责人**不再**连带改写已有学员。
     *
     * 原来这里有一条 updateMany 把该渠道名下所有学员的 channelOwnerId 一起换掉——
     * 张沁做了一年的渠道换李蔚然接手，改一下负责人，张沁过去一年的业绩就全划走了，
     * 而且是静默的。这和 attribution.ts 的「归属固化」（改上游不追溯改写下游）
     * 是同一条原则：没动那个学员的数据，他的归属就不该变。
     * 新负责人只对**之后新增**的学员生效；个别登记错的学员，到他档案里单独改。
     */
    const 换人 = Boolean(改前 && 改前.channelOwnerId !== channelOwnerId);
    const 已有 = 换人 ? await prisma.customer.count({ where: { channelId: input.id } }) : 0;
    await recordAudit({
      user: me, action: "update", entity: "Channel", entityId: input.id,
      summary: `修改渠道「${name}」` +
        (换人 ? `，渠道负责人变更，仅影响之后新增的${b.customer}；已有 ${已有} 名保持原归属` : ""),
      detail: { name, 原负责人: 改前?.channelOwnerId, 新负责人: channelOwnerId, 已有学员不受影响: 已有 },
    });
  } else {
    const c = await prisma.channel.create({ data });
    新建id = c.id;
    await recordAudit({
      user: me, action: "create", entity: "Channel", entityId: c.id,
      summary: `新建渠道「${name}」`,
    });
  }

  revalidatePath("/channels");
  revalidatePath("/customers");
  return { ok: true, id: 新建id ?? input.id! };
}

export async function toggleChannel(id: string, active: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  /*
    另一个窗口已经删了这个渠道：原来 update 直接抛 P2025，界面上点了没反应（2026-10-04 第 2 期 2a，r2-data 那条【下一版】）。
    说一句「已经不在了」
  */
  let c: { name: string };
  try {
    c = await prisma.channel.update({ where: { id }, data: { active } });
  } catch (e) {
    return 不在了(e);
  }
  await recordAudit({
    user: me, action: "update", entity: "Channel", entityId: id,
    summary: `${active ? "启用" : "停用"}渠道「${c.name}」`,
  });
  revalidatePath("/channels");
  return { ok: true };
}

export async function deleteChannel(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  const b = await getBusiness();
  // 已带来学员的渠道不能删，否则推荐链会断、归属数据变成孤儿。
  // attributionChannelId 也要算进来：归属落在该渠道上的学员同样会被置空。
  const used = await prisma.customer.count({
    where: { OR: [{ channelId: id }, { attributionChannelId: id }] },
  });
  if (used > 0) {
    return { ok: false, error: `该渠道名下已有 ${used} 名${b.customer}，不能删除。如需停用请点「停用」` };
  }
  const 待删 = await prisma.channel.findUnique({ where: { id }, select: { name: true } });
  // 另一个窗口已经删了：说一句，不抛（2026-10-04 第 2 期 2a）。查完到删之间又被删的那一下也接住
  if (!待删) return { ok: false, error: "这个渠道已经不在了（可能在别处删了），刷新看看" };
  try {
    await prisma.channel.delete({ where: { id } });
  } catch (e) {
    return 不在了(e);
  }
  await recordAudit({
    user: me, action: "delete", entity: "Channel", entityId: id,
    summary: `删除渠道「${待删.name}」`,
  });
  revalidatePath("/channels");
  return { ok: true };
}
