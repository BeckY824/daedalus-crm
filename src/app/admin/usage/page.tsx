import OpsShell from "../OpsShell";
import UsageView from "./UsageView";
import { 成本概览 } from "@/lib/tenant/ai-cost";
import { control } from "@/lib/tenant/control";
import { 测试账号们 } from "@/lib/tenant/test-accounts";
import { 反馈没处理数, 读功能分布, 近几天 } from "../data";
import { 环境, 验口令 } from "../guard";

export const dynamic = "force-dynamic";

/**
 * 运营台 · 模型用量。把「¥29 / 300 次」从估的换成算的——这份数据只能随时间攒、补不回来。
 * 钱只在配了单价时才显示：我们走中转站，公开价不是实付价，先拍一个估值再拿它算，等于把猜测洗成「数据」。
 */
export default async function UsagePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = await 验口令(searchParams);
  // 测试账号的调用照样记着，但不进这一页的任何数，只在顶上单独说一句（lib/tenant/test-accounts.ts）
  const 测试 = new Set((await 测试账号们()).keys());
  const [成本, 功能, 没处理, 账号们, 工作区们] = await Promise.all([
    成本概览(30, 测试),
    读功能分布(30, new Date(), 测试),
    反馈没处理数(),
    control.account.findMany({ select: { id: true, name: true, phone: true, email: true } }),
    control.workspace.findMany({ select: { id: true, name: true } }),
  ]);
  // 成本概览 只给有调用的日子；这里补齐 30 天，缺的日子不能从横轴上消失
  const 有 = new Map(成本.按天.map((d) => [d.日, d]));
  const 按天 = 近几天(30).map((日) => ({ 日, 数: 有.get(日)?.次数 ?? 0, token: (有.get(日)?.入 ?? 0) + (有.get(日)?.出 ?? 0) }));
  const 账号名 = new Map(账号们.map((a) => [a.id, a.name]));
  const 工作区名 = new Map(工作区们.map((w) => [w.id, w.name]));
  const 榜 = 成本.按归属.map((o) => ({
    kind: o.kind,
    id: o.id,
    名: (o.kind === "account" ? 账号名.get(o.id) : 工作区名.get(o.id)) ?? null,
    次数: o.次数,
    token: o.入 + o.出,
  }));
  return (
    <OpsShell 当前="模型用量" token={token} 环境={环境()} 渲染于={new Date().toISOString()} 反馈没处理={没处理}>
      <UsageView
        token={token}
        合计={成本.合计}
        单价={成本.单价}
        按天={按天}
        按模型={成本.按模型}
        功能={功能}
        榜={榜}
        测试={{ 账号数: 测试.size, 次数: 成本.测试.次数, token: 成本.测试.入 + 成本.测试.出 }}
      />
    </OpsShell>
  );
}
