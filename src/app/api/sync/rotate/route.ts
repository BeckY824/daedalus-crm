import { 认同步, 回 } from "@/lib/tenant/sync-auth";
import { 换钥匙 } from "@/lib/tenant/sync-relay";

export const dynamic = "force-dynamic";

/** 换钥匙（只有建团队的人）。body：{ teamId, epoch, ring, envelopes: [{ device, data }] }——全是桌面端封好的，我们解不开 */
export async function POST(req: Request) {
  const a = await 认同步(req);
  if (!a.ok) return a.res;
  const body = (await req.json().catch(() => ({}))) as { teamId?: string; epoch?: number; ring?: string; envelopes?: { device: string; data: string }[] };
  return 回(await 换钥匙(a.accountId, String(body.teamId ?? ""), Number(body.epoch), String(body.ring ?? ""), Array.isArray(body.envelopes) ? body.envelopes : []));
}
