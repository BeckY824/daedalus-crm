/**
 * 这台电脑上的「我」在团队里是什么业务角色（老板 / 总管理 / 管理员 / 业务员……，见 lib/sync/dept-policy）。
 *
 * 本机 User.role 只有三档（老板 = ADMIN、管理员和总管理都是 MANAGER、其余 SALES），分不出「管理员」和「主管」；
 * 要按业务角色放行的地方（2026-10-27 跟进渠道：老板和管理员能改）看这里。编制是名单带回来的、存在 .team.json 里，
 * 没开团队、老服务器不回编制时为空——按没有业务角色算，只剩老板（ADMIN）能改。云端照样按同一张角色表再拦一次
 */
import { 读团队 } from "@/lib/sync/client";
import { 本地模式, 读 as 读云端凭据 } from "./cloud";
import { 能管人, type 业务角色 } from "@/lib/sync/dept-policy";

export function 本机业务角色(): string | undefined {
  if (!本地模式()) return undefined;
  const 我 = 读云端凭据()?.accountId;
  return 我 ? 读团队()?.编制?.成员编制[我]?.bizRole : undefined;
}

/** 总管理、管理员 */
export function 本机能管人(): boolean {
  const r = 本机业务角色();
  return !!r && 能管人.has(r as 业务角色);
}
