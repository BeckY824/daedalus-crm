"use client";

import { useEffect, useState } from "react";
import { App, Alert, Button } from "antd";
import { DesktopOutlined } from "@ant-design/icons";
import { 发起连接动作, 查连接动作, 取消连接动作 } from "./team-actions";

/**
 * 新电脑连上团队（2026-10-15 多设备同步，lib/sync/device-link.ts）。
 * 这个账号在云上已经是某个团队的成员、这台电脑还没连上时，「设置 → 团队」最上面是这一张：
 * 点「在我的另一台电脑上允许」→ 显示配对数字 → 本人已经连上的那台弹出授权框，对上数字点允许 → 这台自动连上。
 * 另一台不在身边：下面照旧能粘邀请码（找老板要）。
 */
export default function ConnectCard({ 团名, 我是建的人, 等授权, 本机客户, onJoined }: {
  团名: string;
  我是建的人: boolean;
  等授权: { 配对数字: string } | null;
  本机客户: number;
  onJoined: () => void;
}) {
  const { message } = App.useApp();
  const [数字, set数字] = useState<string | null>(等授权?.配对数字 ?? null);
  const [忙, set忙] = useState(false);
  const [结果, set结果] = useState<"denied" | "expired" | "removed" | null>(null);

  // 在等：每 4 秒问一次另一台点了没
  useEffect(() => {
    if (!数字) return;
    let 停 = false;
    const 问 = async () => {
      const r = await 查连接动作().catch(() => null);
      if (停 || !r) return;
      if (!r.ok) { message.error(r.error); return; }
      if (r.status === "joined") { message.success(`已连上「${团名}」，开始同步`); onJoined(); return; }
      if (r.status === "denied" || r.status === "expired" || r.status === "removed") { set结果(r.status); set数字(null); }
    };
    const t = setInterval(() => void 问(), 4_000);
    void 问();
    return () => { 停 = true; clearInterval(t); };
  }, [数字, 团名, message, onJoined]);

  async function 发起() {
    set忙(true);
    set结果(null);
    const r = await 发起连接动作();
    set忙(false);
    if (!r.ok) return void message.error(r.error);
    set数字(r.配对数字);
  }
  async function 不等了() {
    await 取消连接动作();
    set数字(null);
  }

  return (
    <section className="team-card" data-testid="team-connect">
      <h3><DesktopOutlined /> 你的账号在团队「{团名}」里，这台电脑还没连上</h3>
      <p className="muted">
        在你自己另一台已经连上的电脑上点一下「允许」，这台就会收到团队钥匙、开始同步{我是建的人 ? "（老板的管理权限也一起过来，这台也能移除同事、换邀请码）" : ""}。
        钥匙在两台电脑之间加密转交，我们看不到内容。
      </p>
      {本机客户 > 0 && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={`这台电脑上已有的 ${本机客户} 位客户会带进团队`}
          description="和云上的合在一起、不覆盖；同一位客户两边各有一份的，会列在「疑似重复」里。连上之前会先自动备份一份。" />
      )}
      {结果 === "denied" && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="另一台电脑点了「不允许」" />}
      {结果 === "expired" && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="等太久过期了，请再发一次" />}
      {数字 ? (
        <div className="mobile-pair" data-testid="device-link-waiting">
          <span className="muted">请到你的另一台电脑上（打开 Daedalus），核对弹框里的数字是</span>
          <b data-testid="device-pair-code">{数字.slice(0, 3)} {数字.slice(3)}</b>
          <span className="muted">一样就点「允许」。那台没开着的话，开机打开 Daedalus 就会弹出来。</span>
          <Button size="small" type="text" onClick={() => void 不等了()}>不等了</Button>
        </div>
      ) : (
        <Button type="primary" icon={<DesktopOutlined />} loading={忙} onClick={() => void 发起()}>在我的另一台电脑上允许</Button>
      )}
    </section>
  );
}
