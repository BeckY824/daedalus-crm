import { notFound } from "next/navigation";
import { control } from "@/lib/tenant/control";
import { multiTenant } from "@/lib/tenant/context";
import { 成本概览 } from "@/lib/tenant/ai-cost";
import { computeWritable, daysLeft } from "@/lib/tenant/workspaces";
import AdminView from "./AdminView";

export const dynamic = "force-dynamic";

/**
 * 运营台：看有多少工作区在试用、谁提交了付款、手动开通。
 *
 * 刻意**不挂在应用的登录体系里**——它属于我们，不属于任何工作区，
 * 而 (app) 下的所有页面都会被 requireUser 拉进某个工作区的上下文。
 * 用一个独立的 ADMIN_TOKEN 保护：只有我们几个人用，不值得为它做一套账号。
 *
 * 这里原来还管着三种码（一次性邀请码、万能码、演示码）的生成和查看。
 * 整套码 2026-09-15 下线：开号只有「注册」一条路，演示区进门不要码。
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = process.env.ADMIN_TOKEN;
  const { token: given } = await searchParams;
  // 没配 token 就当这个页面不存在，免得自部署的人暴露一个无保护的运营台
  if (!multiTenant() || !token || given !== token) notFound();

  const [rows, 赠送, 用量, 反馈, 成本, 账号们, 账号赠送, 账号用量, 设备们] = await Promise.all([
    control.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { memberships: { include: { account: true } } },
    }),
    // AI 次数：每个工作区送了多少、用了多少，运营台一眼看到谁快用完了
    control.aiGrant.groupBy({ by: ["workspaceId"], _sum: { amount: true } }),
    control.aiUsage.findMany(),
    /* 用户从界面里发来的话。没人看的收件箱等于没有这个功能，所以它和工作区摆在同一页 */
    control.feedback.findMany({ orderBy: { at: "desc" }, take: 100 }),
    /* 模型成本：把「¥29 / 300 次」从估的换成算的，全靠这一份随时间攒的数据 */
    成本概览(14),
    /*
      桌面端用户。**他们没有工作区**——桌面端注册只开一个云端账号（记 AI 次数、发设备令牌），
      数据全在他自己机器上。所以上面那张按工作区列的表里一个都看不到，
      而内测用户全是这一类：谁注册了、领了几台设备、免费次数还剩多少，得另有一张表。

      这几张表和 Account 之间没有关系字段（只有裸的 accountId），所以分开查、在内存里拼。
      量很小：一个账号一行。
    */
    control.account.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { memberships: { select: { workspaceId: true } } },
    }),
    control.accountAiGrant.groupBy({ by: ["accountId"], _sum: { amount: true } }),
    control.accountAiUsage.findMany(),
    // 只算没被吊销的：吊销过的设备不再代表「他手上有几台」
    control.deviceToken.findMany({ where: { revokedAt: null }, select: { accountId: true, lastUsedAt: true } }),
  ]);
  const 送表 = new Map(赠送.map((g) => [g.workspaceId, g._sum.amount ?? 0]));
  const 用表 = new Map(用量.map((u) => [u.workspaceId, u.calls]));

  const 账送 = new Map(账号赠送.map((g) => [g.accountId, g._sum.amount ?? 0]));
  const 账用 = new Map(账号用量.map((u) => [u.accountId, u.calls]));
  const 设备表 = new Map<string, { 台数: number; 最近: Date | null }>();
  for (const d of 设备们) {
    const 旧 = 设备表.get(d.accountId) ?? { 台数: 0, 最近: null };
    旧.台数 += 1;
    if (d.lastUsedAt && (!旧.最近 || d.lastUsedAt > 旧.最近)) 旧.最近 = d.lastUsedAt;
    设备表.set(d.accountId, 旧);
  }

  const 账号 = 账号们.map((a) => {
    const 送 = 账送.get(a.id) ?? 0;
    const 用 = 账用.get(a.id) ?? 0;
    const d = 设备表.get(a.id);
    return {
      id: a.id,
      name: a.name,
      contact: a.phone ?? a.email ?? "",
      createdAt: a.createdAt.toISOString(),
      lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
      active: a.active,
      设备: d?.台数 ?? 0,
      最近用令牌: d?.最近 ? d.最近.toISOString() : null,
      ai: { 送, 用, 剩: Math.max(0, 送 - 用) },
      /** 有工作区的是网页版那条路；没有的才是纯桌面端 */
      工作区数: a.memberships.length,
    };
  });

  /*
    成本块里「烧得最多的前 10」原来显示的是一串 id——知道有人烧得凶，不知道是谁。
    在这儿把 id 换成人：账号给名字和联系方式，工作区给名字。
  */
  const 账号名 = new Map(账号们.map((a) => [a.id, `${a.name}${a.phone ?? a.email ? ` · ${a.phone ?? a.email}` : ""}`]));
  const 工作区名 = new Map(rows.map((w) => [w.id, w.name]));
  const 成本带名 = {
    ...成本,
    按归属: 成本.按归属.map((o) => ({
      ...o,
      名: (o.kind === "account" ? 账号名.get(o.id) : 工作区名.get(o.id)) ?? undefined,
    })),
  };

  const list = rows.map((w) => {
    const owner = w.memberships.find((m) => m.role === "OWNER")?.account;
    const 送 = 送表.get(w.id) ?? 0;
    return {
      id: w.id,
      slug: w.slug,
      name: w.name,
      status: w.status,
      writable: computeWritable(w),
      daysLeft: daysLeft(w),
      createdAt: w.createdAt.toISOString(),
      paidUntil: w.paidUntil ? w.paidUntil.toISOString() : null,
      members: w.memberships.length,
      owner: owner ? { name: owner.name, contact: owner.phone ?? owner.email ?? "" } : null,
      ai: { 送, 剩: Math.max(0, 送 - (用表.get(w.id) ?? 0)) },
      // 待核对的付款记在这里，运营台一眼看到谁交了钱
      note: w.note,
    };
  });

  /*
    顶栏那个环境标记。这一页对着的是线上库，一个动作就能停掉别人的工作区——
    人得一眼知道自己点的是生产还是本地。
  */
  return (
    <AdminView
      token={given}
      rows={list}
      环境={process.env.NODE_ENV === "production" ? "生产" : "本地"}
      成本={成本带名}
      账号={账号}
      反馈={反馈.map((f) => ({
        id: f.id,
        at: f.at.toISOString(),
        source: f.source,
        body: f.body,
        path: f.path,
        version: f.version,
        platform: f.platform,
        who: f.who,
        handled: f.handled,
      }))}
    />
  );
}
