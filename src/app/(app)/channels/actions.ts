"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { 唯一负责人 } from "@/lib/owners";
import { getBusiness } from "@/lib/business";

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
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireUser();
  const b = await getBusiness();
  const name = input.name.trim();
  const channelOwnerId = input.channelOwnerId || (await 唯一负责人());
  if (!channelOwnerId) return { ok: false, error: "请选择渠道负责人" };

  const dup = await prisma.channel.findFirst({
    where: { name, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true },
  });
  if (dup) return { ok: false, error: `渠道「${name}」已存在` };

  const data = {
    name,
    phone: input.phone?.trim() || null,
    remark: input.remark?.trim() || null,
    channelOwnerId,
  };

  let 新建id: string | undefined;

  if (input.id) {
    const 改前 = await prisma.channel.findUnique({ where: { id: input.id }, select: { channelOwnerId: true } });
    await prisma.channel.update({ where: { id: input.id }, data });
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

export async function toggleChannel(id: string, active: boolean) {
  const me = await requireUser();
  const c = await prisma.channel.update({ where: { id }, data: { active } });
  await recordAudit({
    user: me, action: "update", entity: "Channel", entityId: id,
    summary: `${active ? "启用" : "停用"}渠道「${c.name}」`,
  });
  revalidatePath("/channels");
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
  await prisma.channel.delete({ where: { id } });
  await recordAudit({
    user: me, action: "delete", entity: "Channel", entityId: id,
    summary: `删除渠道「${待删?.name ?? id}」`,
  });
  revalidatePath("/channels");
  return { ok: true };
}
