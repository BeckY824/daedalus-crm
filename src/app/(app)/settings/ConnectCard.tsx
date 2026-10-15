"use client";

import { DesktopOutlined } from "@ant-design/icons";
import ConnectPanel, { type 连接信息 } from "./ConnectPanel";

/**
 * 新电脑连上团队（2026-10-15 多设备同步，lib/sync/device-link.ts）。
 * 这个账号在云上已经是某个团队的成员、这台电脑还没连上时，「设置 → 团队」最上面是这一张：
 * 点「在我的另一台电脑或手机上允许」→ 显示配对数字 → 本人已经连上的电脑或手机弹出授权框，对上数字点允许 → 这台自动连上。
 * 首页打开时已经自动弹框发过申请的（components/TeamConnectPrompt），这里显示同一组数字（同一个申请，见 ConnectPanel）。
 * 另一台不在身边：下面照旧能粘邀请码（找老板要）。
 */
export default function ConnectCard({ onJoined, ...x }: 连接信息 & { onJoined: () => void }) {
  return (
    <section className="team-card" data-testid="team-connect">
      <h3><DesktopOutlined /> 你的账号在团队「{x.团名}」里，这台电脑还没连上</h3>
      <ConnectPanel {...x} onJoined={onJoined} />
    </section>
  );
}
