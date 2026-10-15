"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { App, Alert, Button } from "antd";
import { DesktopOutlined } from "@ant-design/icons";
import { 发起连接动作, 查连接动作, 取消连接动作 } from "./team-actions";

/**
 * 新电脑连上团队的那一块（2026-10-15 多设备同步，lib/sync/device-link.ts）：说明、本机已有客户、配对数字、等待、被拒 / 过期再发、不等了。
 * 两处用它：首页自动弹的框（components/TeamConnectPrompt，打开就发申请）和「设置 → 团队」最上面那张卡（ConnectCard，点了才发）。
 * 两处是**同一个申请**：半路的钥匙对存在本机 .team-link.json，再发一次也是同一对、同一组数字，服务端也是同一条申请（按登录令牌认）；
 * 已经在等就直接显示数字、不再发。关掉框不撤申请，只有点「不等了」才撤。
 */
export type 连接信息 = { 团名: string; 我是建的人: boolean; 等授权: { 配对数字: string } | null; 本机客户: number };

export default function ConnectPanel({ 团名, 我是建的人, 等授权, 本机客户, 自动发起, onJoined, 尾 }: 连接信息 & {
  /** 首页的框：还没发过就一打开自动发 */
  自动发起?: boolean;
  onJoined: () => void;
  /** 框底部的按钮（「以后再说」）；卡片里没有 */
  尾?: ReactNode;
}) {
  const { message } = App.useApp();
  const [数字, set数字] = useState<string | null>(等授权?.配对数字 ?? null);
  const [忙, set忙] = useState(false);
  const [结果, set结果] = useState<"denied" | "expired" | "removed" | null>(null);
  // 发不出去（设备满了 3 台、没登录、连不上）：说在框里，不空转
  const [错, set错] = useState<string | null>(null);
  const 回 = useRef(onJoined);
  useEffect(() => { 回.current = onJoined; });

  // 在等：每 4 秒问一次另一台点了没
  useEffect(() => {
    if (!数字) return;
    let 停 = false;
    const 问 = async () => {
      const r = await 查连接动作().catch(() => null);
      if (停 || !r) return;
      if (!r.ok) { set错(r.error); return; }
      if (r.status === "joined") { 停 = true; message.success(`已连上「${团名}」，开始同步`); 回.current(); return; }
      // none：半路的钥匙不在了（在另一个窗口点了不等了、换了账号）
      if (r.status === "denied" || r.status === "expired" || r.status === "removed" || r.status === "none") { set结果(r.status === "none" ? null : r.status); set数字(null); }
    };
    const t = setInterval(() => void 问(), 4_000);
    void 问();
    return () => { 停 = true; clearInterval(t); };
  }, [数字, 团名, message]);

  const 发起 = useCallback(async () => {
    set忙(true);
    set结果(null);
    set错(null);
    const r = await 发起连接动作().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    set忙(false);
    if (!r.ok) return void set错(r.error);
    set数字(r.配对数字);
  }, []);

  // 首页的框：打开就发（已经在等的不发，直接显示上面那组数字）
  const 发过 = useRef(false);
  useEffect(() => {
    if (!自动发起 || 发过.current || 等授权) return;
    发过.current = true;
    void 发起();
  }, [自动发起, 等授权, 发起]);

  async function 不等了() {
    await 取消连接动作();
    set数字(null);
  }

  return (
    <div data-testid="connect-panel">
      <p className="muted">
        在你自己另一台已经连上的电脑或手机上点一下「允许」，这台就会收到团队钥匙、开始同步。钥匙在你的设备之间加密转交，我们看不到内容。
        {我是建的人 && <><br />想让这台也能移除同事、换邀请码：要在<b>建团队的那台电脑</b>（或它授权的电脑）上点允许，老板的管理权限才会一起过来；在手机上允许的话，这台能看能记，但管不了团队。</>}
      </p>
      {本机客户 > 0 && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          title={`这台电脑上已有的 ${本机客户} 位客户会带进团队`}
          description="和云上的合在一起、不覆盖；同一位客户两边各有一份的，会列在「疑似重复」里。连上之前会先自动备份一份。" />
      )}
      {结果 === "denied" && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="另一台设备上点了「不允许」" />}
      {(结果 === "expired" || 结果 === "removed") && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title="这次申请过期了，请再发一次" />}
      {错 && <Alert type="error" showIcon style={{ marginBottom: 12 }} title={错} data-testid="connect-error" />}
      {数字 ? (
        <div className="mobile-pair" data-testid="device-link-waiting">
          <span className="muted">请到你另一台已连上的电脑（打开 Daedalus）或手机（打开手机版），核对弹框里的数字是</span>
          <b data-testid="device-pair-code">{数字.slice(0, 3)} {数字.slice(3)}</b>
          <span className="muted">一样就点「允许」。那台没开着的话，打开 Daedalus 或手机版就会弹出来。</span>
          <Button size="small" type="text" onClick={() => void 不等了()}>不等了（撤回这次申请）</Button>
        </div>
      ) : (
        <Button type="primary" icon={<DesktopOutlined />} loading={忙} onClick={() => void 发起()}>
          {结果 || 错 ? "再发一次" : "在我的另一台电脑或手机上允许"}
        </Button>
      )}
      {尾 && <div style={{ marginTop: 16, textAlign: "right" }}>{尾}</div>}
    </div>
  );
}
