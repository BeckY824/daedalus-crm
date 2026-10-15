/**
 * 我的设备（2026-10-15 多设备同步，方案：~/Opensource_CRM/02-开发与发版/多设备同步-方案-20261015.md 第 2.4 节）。
 *
 * 同一个人在团队里登记的电脑和手机列在一起：名字（电脑是登录时的机器名、手机是申请时的型号）、什么时候连上的、最近一次同步。
 * 不用了 / 丢了的那台在这里移除：
 *   - 注销同步设备（之后换钥匙不再封给它）、作废它的登录令牌（它马上退出登录，拉不到也推不了）
 *   - 记下「这个团队该换钥匙了」，老板那台下次同步时换（那台里还留着旧钥匙）
 * 只看得到、只移除得了自己账号的设备；正在用的这台不能在这里移除（要停用请「退出团队」）。
 */
import { control } from "./control";
import { 在队里, 记要换钥匙, 每人设备上限 } from "./sync-relay";

type 结果<T> = ({ ok: true } & T) | { ok: false; 状态: number; error: string };
const 错 = (状态: number, error: string) => ({ ok: false as const, 状态, error });

export type 我的一台 = { device: string; 种类: "电脑" | "手机"; label: string; 连上: Date; 最近同步: Date | null; 这台: boolean };

const 晚的 = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? (a > b ? a : b) : (a ?? b ?? null));

export async function 我的设备(accountId: string, teamId: string, 调用令牌: string): Promise<结果<{ devices: 我的一台[]; 上限: number }>> {
  if (!(await 在队里(String(teamId ?? ""), accountId))) return 错(403, "你不在这个团队里");
  const 机们 = await control.syncDevice.findMany({ where: { teamId, accountId }, orderBy: { createdAt: "asc" } });
  const 记录 = new Map((await control.syncDeviceSeen.findMany({ where: { teamId, accountId } })).map((x) => [x.device, x]));
  const 手机申请 = new Map((await control.syncMobileLink.findMany({ where: { accountId, teamId, status: "approved" } })).map((l) => [l.device, l]));
  const 令牌ids = [...new Set([...机们.map((m) => 记录.get(m.device)?.tokenId), ...[...手机申请.values()].map((l) => l.tokenId)].filter((x): x is string => !!x))];
  const 令牌 = new Map((await control.deviceToken.findMany({ where: { id: { in: 令牌ids }, accountId }, select: { id: true, name: true, lastUsedAt: true } })).map((t) => [t.id, t]));
  const devices = 机们.map((m): 我的一台 => {
    const 记 = 记录.get(m.device);
    const 申 = 手机申请.get(m.device);
    const 电脑 = !m.device.startsWith("m_");
    const tokenId = 记?.tokenId ?? 申?.tokenId ?? null;
    const t = tokenId ? 令牌.get(tokenId) : undefined;
    // 电脑：登录时报的机器名（lib/desktop/cloud.ts 设备名）。手机：申请时的「iPhone · Safari」。都没有（老版本登记的）就只写种类
    const label = (电脑 ? t?.name : 申?.label) || (电脑 ? "电脑" : "手机");
    return { device: m.device, 种类: 电脑 ? "电脑" : "手机", label, 连上: m.createdAt, 最近同步: 晚的(记?.lastSeenAt, t?.lastUsedAt), 这台: !!tokenId && tokenId === 调用令牌 };
  });
  return { ok: true, devices, 上限: 每人设备上限 };
}

export async function 移除我的设备(accountId: string, teamId: string, device: string, 调用令牌: string): Promise<结果<object>> {
  if (!(await 在队里(String(teamId ?? ""), accountId))) return 错(403, "你不在这个团队里");
  const 机 = await control.syncDevice.findUnique({ where: { teamId_device: { teamId, device: String(device ?? "") } } });
  if (!机 || 机.accountId !== accountId) return 错(404, "这台设备不在了");
  const 记 = await control.syncDeviceSeen.findUnique({ where: { teamId_device: { teamId, device: 机.device } } });
  const 申 = await control.syncMobileLink.findFirst({ where: { accountId, teamId, device: 机.device, status: "approved" } });
  const 令牌们 = [记?.tokenId, 申?.tokenId].filter((x): x is string => !!x);
  if (令牌们.includes(调用令牌)) return 错(400, "正在用的这台不能在这里移除：要让这台停止同步，请点「退出团队」");
  await control.$transaction(async (tx) => {
    await tx.syncDevice.deleteMany({ where: { teamId, device: 机.device, accountId } });
    await tx.syncDeviceSeen.deleteMany({ where: { teamId, device: 机.device, accountId } });
    await tx.syncMobileLink.updateMany({ where: { accountId, device: 机.device, status: { in: ["approved", "pending"] } }, data: { status: "removed", sealed: null, decidedAt: new Date() } });
    // 那台马上退出登录：它的令牌拿去调哪个接口都是「登录已失效」
    if (令牌们.length) await tx.deviceToken.updateMany({ where: { id: { in: 令牌们 }, accountId, revokedAt: null }, data: { revokedAt: new Date() } });
    await 记要换钥匙(teamId, tx);
  });
  return { ok: true };
}
