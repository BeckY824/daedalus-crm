import { 认同步 } from "@/lib/tenant/sync-auth";
import { 范围状态, 范围目录, 开始范围迁移, 完成范围迁移, 收范围推送, 给范围拉取, 范围错误, 范围开放, 核设备, 收查重索引, 查查重, type 范围包 } from "@/lib/tenant/sync-scoped";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const auth = await 认同步(req); if (!auth.ok) return auth.res;
  if (Number(req.headers.get('content-length') ?? 0) > 9 * 1024 * 1024) return Response.json({ error: '范围请求过大' }, { status: 413 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.teamId !== 'string') return Response.json({ error: '请求格式不对' }, { status: 400 });
  const { teamId, action } = body;
  try {
    const a = auth.accountId;
    // 灰度未开、团队也没迁移过：除 state 外一律 404，桌面端据此继续走旧协议（生产默认关）
    if (action !== 'state' && !(await 范围开放(teamId))) return Response.json({ error: '范围同步尚未开放' }, { status: 404 });
    if (action === 'state') return Response.json(await 范围状态(a, teamId));
    // 带设备号的（推送、新客户端的目录和拉取）：被「我的设备」移除的挡下，其余顺手记最近同步时间
    if (action === 'directory' || action === 'pull' || action === 'push' || action === 'dedupe-put') await 核设备(a, teamId, body.device, auth.tokenId);
    if (action === 'directory') return Response.json(await 范围目录(a, teamId));
    if (action === 'begin' && typeof body.device === 'string') return Response.json(await 开始范围迁移(a, teamId, body.device));
    if (action === 'commit' && typeof body.device === 'string' && Number.isSafeInteger(body.count)) return Response.json(await 完成范围迁移(a, teamId, body.device, body.count));
    if (action === 'push' && typeof body.device === 'string') return Response.json(await 收范围推送(a, teamId, body.device, body.packets as 范围包[]));
    if (action === 'pull' && typeof body.scopeId === 'string') return Response.json(await 给范围拉取(a, teamId, body.scopeId, Number(body.after) || 0));
    // 跨成员查重（2026-10-19）：各台报自己看得到的客户的号码哈希；录入前问一下是不是同事名下的
    if (action === 'dedupe-put' && typeof body.device === 'string') return Response.json(await 收查重索引(a, teamId, body.device, body.entries));
    if (action === 'dedupe-find') return Response.json(await 查查重(a, teamId, body.hashes));
    return Response.json({ error: '未知同步操作' }, { status: 400 });
  } catch (e) {
    if (e instanceof 范围错误) return Response.json(e.denied ? { error: e.message, denied: e.denied, ...(e.gone?.length ? { gone: e.gone } : {}), ...(e.taken ? { taken: e.taken } : {}) } : { error: e.message }, { status: e.状态 });
    console.error('[sync-scoped] 请求失败', e instanceof Error ? e.name : 'unknown');
    return Response.json({ error: '范围同步暂不可用，请稍后重试' }, { status: 503 });
  }
}
