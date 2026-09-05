"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

/**
 * 成功时回传渠道 id（新建是新 id，编辑是原 id）。
 * 「新建学员」里就地建渠道后要立刻把它选中，没有 id 就选不上。
 */
export async function saveChannel(input: {
  id?: string;
  name: string;
  phone: string | null;
  remark: string | null;
  channelOwnerId: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireUser();
  const name = input.name.trim();

  const dup = await prisma.channel.findFirst({
    where: { name, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true },
  });
  if (dup) return { ok: false, error: `渠道「${name}」已存在` };

  const data = {
    name,
    phone: input.phone?.trim() || null,
    remark: input.remark?.trim() || null,
    channelOwnerId: input.channelOwnerId,
  };

  let 新建id: string | undefined;

  if (input.id) {
    const 改前 = await prisma.channel.findUnique({ where: { id: input.id }, select: { channelOwnerId: true } });
    await prisma.channel.update({ where: { id: input.id }, data });
    // 渠道负责人变更后，该渠道整条推荐链上的学员都要跟着改
    const 波及 = await prisma.customer.updateMany({
      where: { channelId: input.id },
      data: { channelOwnerId: input.channelOwnerId },
    });
    await recordAudit({
      user: me, action: "update", entity: "Channel", entityId: input.id,
      summary: `修改渠道「${name}」` +
        (改前 && 改前.channelOwnerId !== input.channelOwnerId
          ? `，渠道负责人变更，连带改了 ${波及.count} 名学员的归属`
          : ""),
      detail: { name, 原负责人: 改前?.channelOwnerId, 新负责人: input.channelOwnerId, 波及学员: 波及.count },
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
  await requireUser();
  await prisma.channel.update({ where: { id }, data: { active } });
  revalidatePath("/channels");
}

export async function deleteChannel(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireUser();
  // 已带来学员的渠道不能删，否则推荐链会断、归属数据变成孤儿。
  // attributionChannelId 也要算进来：归属落在该渠道上的学员同样会被置空。
  const used = await prisma.customer.count({
    where: { OR: [{ channelId: id }, { attributionChannelId: id }] },
  });
  if (used > 0) {
    return { ok: false, error: `该渠道名下已有 ${used} 名学员，不能删除。如需停用请点「停用」` };
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
