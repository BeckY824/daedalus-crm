"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, Modal } from "antd";
import { DesktopOutlined } from "@ant-design/icons";
import { 待连接团队动作 } from "@/app/(app)/settings/team-actions";
import ConnectPanel, { type 连接信息 } from "@/app/(app)/settings/ConnectPanel";

/**
 * 新电脑登录同一个账号（2026-10-15 多设备同步；10-15 实测后改成打开就弹框发申请，和手机登录后一样）：
 * 账号在云上是团队成员、这台还没连上，打开应用就弹一个框，同时发出申请、显示配对数字——
 * 本人已连上的电脑（components/MobileAuthPrompt）、手机（/m 的批准框）马上弹「允许」，不用再进「设置 → 团队」点按钮。
 * 和设置页那张卡是同一个申请（ConnectPanel）；关掉框不撤申请。「以后再说」：这次打开不再弹（只想单机用的人）。
 * 在「设置」页上不弹：那里有同一张卡。只在桌面端本地模式挂（layout.tsx）。
 */
const 不弹键 = "daedalus:team-connect-later";
/** 问不到云端时再问的间隔：30 秒、2 分钟、5 分钟，之后这次打开不再问 */
export const 再问间隔 = [30_000, 120_000, 300_000];

export default function TeamConnectPrompt() {
  const router = useRouter();
  const 路径 = usePathname();
  const [信息, set信息] = useState<连接信息 | null>(null);
  const [开, set开] = useState(false);

  useEffect(() => {
    let 停 = false;
    let 等: ReturnType<typeof setTimeout> | undefined;
    try { if (sessionStorage.getItem(不弹键)) return; } catch { /* 读不了就照常问 */ }
    // 云端没答上来（超时、断网、5xx）不等于「没有团」：隔一会儿再问，最多问 再问间隔.length 轮（2026-10-28 D-03）
    const 问 = (第几次: number) => {
      void 待连接团队动作().then((r) => {
        if (停 || !r) return;
        if ("问不到" in r) {
          if (第几次 < 再问间隔.length) 等 = setTimeout(() => 问(第几次 + 1), 再问间隔[第几次]);
          return;
        }
        set信息(r);
        set开(true);
      }).catch(() => {
        if (!停 && 第几次 < 再问间隔.length) 等 = setTimeout(() => 问(第几次 + 1), 再问间隔[第几次]);
      });
    };
    问(0);
    return () => { 停 = true; clearTimeout(等); };
  }, []);

  if (!信息 || 路径?.startsWith("/settings")) return null;
  const 以后再说 = () => {
    try { sessionStorage.setItem(不弹键, "1"); } catch { /* 只是这次会再弹 */ }
    set开(false);
  };
  return (
    <Modal open={开} onCancel={以后再说} footer={null} mask={{ closable: false }} width={520}
      title={<><DesktopOutlined /> 你的账号在团队「{信息.团名}」里，这台电脑还没连上</>}>
      <ConnectPanel {...信息} 自动发起
        onJoined={() => { set开(false); router.refresh(); }}
        尾={<Button onClick={以后再说} data-testid="connect-later">以后再说</Button>} />
    </Modal>
  );
}
