import { prisma, defaultClient } from "@/lib/prisma";
import { 限定的我 } from "@/lib/team-scope";
import { 缓存着 } from "@/lib/home-cache";
import { requireUser } from "@/lib/auth";
import PipelineView from "./PipelineView";
import { 负责人候选 } from "@/lib/owners";
import { 取管道 } from "@/lib/pipeline-page";
import { 读每列, 读新 } from "@/lib/pipeline-columns";
import { dayjs } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** 赢单列摆近几天赢下的（2026-10-04 J-090）。page 文件只许导出 Next 认的那几样，所以不 export */
const 赢单列天数 = 30;

export default async function PipelinePage({ searchParams }: { searchParams?: Promise<{ n?: string; new?: string }> } = {}) {
  await requireUser();
  const sp = (await searchParams) ?? {};
  /*
    赢单列摆近 30 天赢下的（2026-10-04 J-090）。原来只取进行中的：拖进「赢单成交」那一刻卡片就消失了，
    人以为拖丢了；而赢单列永远是空的。全摆出来又会越积越长、列头合计成了历年总额，所以只摆近 30 天。
    老商机没有结单时刻那一行（0.46.15 之前赢的），退回按 updatedAt 算。
  */
  const 起 = dayjs().subtract(赢单列天数, "day").toDate();
  // 每列先摆 50 张，列头合计按全部算（lib/pipeline-page.ts，2026-10-24 企业版压测）
  const 每列 = 读每列(sp.n);

  const [页, users] = await Promise.all([
    // 不限定（老板、个人版、企业版没开按组织看）时轻查询走短时缓存（lib/pipeline-page.ts）
    (async () => 取管道(prisma, 起, 每列, 读新(sp.new), (await 限定的我(defaultClient)) ? undefined : 缓存着))(),
    // 新建框要的候选：和列表页同一个框（../OpportunityForm.tsx）
    负责人候选(),
  ]);

  return (
    <PipelineView
      赢单天数={赢单列天数}
      users={users}
      customers={[]}
      rows={页.rows}
      列={页.列}
      总条数={页.总条数}
      全部负责人={页.负责人}
      每列={每列}
    />
  );
}
