"use client";

import { useEffect, useRef, useState } from "react";
import { App, Button, Modal } from "antd";
import { DesktopOutlined, MobileOutlined } from "@ant-design/icons";
import { 待授权手机动作, 允许手机动作, 拒绝手机动作 } from "@/app/(app)/settings/team-actions";

/**
 * 手机来要授权时弹出来（2026-10-15，手机端方案 3.2）。只在桌面端本地模式、这台进了团队时挂（layout.tsx，10-22 起个人版不挂）。
 * 窗口在前台时每 15 秒问一次云端有没有本账号的手机在等；不在团队里时 待授权手机 直接回空、不联网。
 * 框里写清楚三件事：传什么、谁看得到、怎么取消；再加配对数字——和手机屏幕上的对一下，对不上别点允许。
 * 2026-10-15 多设备同步：本人的新电脑也从这里授权（申请走同一个接口，电脑 = true），框里的话换成电脑的。
 */
type 待 = { id: string; label: string; createdAt: string; 配对数字: string; 电脑: boolean };

export default function MobileAuthPrompt() {
  const { message } = App.useApp();
  const [当前, set当前] = useState<待 | null>(null);
  const [忙, set忙] = useState<"允许" | "拒绝" | null>(null);
  // 这次打开应用里点过「稍后」的，不再弹（下次打开再说；设置 → 团队里也能处理）
  const 稍后 = useRef(new Set<string>());

  useEffect(() => {
    let 停 = false;
    const 问 = async () => {
      if (document.hidden || 当前) return;
      const r = await 待授权手机动作().catch(() => null);
      if (停 || !r?.ok) return;
      const x = r.手机.find((p) => !稍后.current.has(p.id));
      if (x) set当前(x);
    };
    void 问();
    const t = setInterval(() => void 问(), 15_000);
    const 回前台 = () => { if (!document.hidden) void 问(); };
    document.addEventListener("visibilitychange", 回前台);
    return () => { 停 = true; clearInterval(t); document.removeEventListener("visibilitychange", 回前台); };
  }, [当前]);

  if (!当前) return null;
  const 关 = () => set当前(null);
  async function 允许() {
    set忙("允许");
    const r = await 允许手机动作(当前!.id, 当前!.label, 当前!.电脑);
    set忙(null);
    if (!r.ok) { message.error(r.error); return; }
    message.success(当前!.电脑 ? "已授权，那台电脑马上开始同步" : "已授权，手机上马上开始同步");
    window.dispatchEvent(new Event("daedalus:mobile-linked"));
    关();
  }
  async function 拒绝() {
    set忙("拒绝");
    const r = await 拒绝手机动作(当前!.id);
    set忙(null);
    if (!r.ok) { message.error(r.error); return; }
    关();
  }

  const 电脑 = 当前.电脑;
  return (
    <Modal open title={电脑 ? <><DesktopOutlined /> 允许「{当前.label}」加入团队同步？</> : <><MobileOutlined /> 允许「{当前.label}」查看和记录你的客户？</>} onCancel={() => { 稍后.current.add(当前.id); 关(); }} mask={{ closable: false }}
      // 设备名长（「HUAWEI Mate 60 Pro · 华为浏览器 · 深圳市南山区」）时标题第一行会钻到右上 × 底下：给 × 让出位置（10-19 排版闸门「压字」）
      styles={{ header: { paddingInlineEnd: 36 } }}
      footer={[
        <Button key="no" danger disabled={忙 !== null} loading={忙 === "拒绝"} onClick={() => void 拒绝()}>不允许</Button>,
        <Button key="yes" type="primary" disabled={忙 !== null} loading={忙 === "允许"} onClick={() => void 允许()}>允许</Button>,
      ]}>
      {电脑 ? (
        <p>这是用<b>你的账号</b>登录的另一台电脑。允许后，那台电脑拿到团队钥匙，和这台一样同步你能看到的客户、跟进、商机。我们的服务器只负责转交，看不到内容。</p>
      ) : (
        <p>会把你能看到的客户、联系人、商机阶段和跟进，加密后传到这台手机。我们的服务器只负责转交，看不到内容。</p>
      )}
      <p>随时可以在「设置 → 团队 → 我的设备」里移除。</p>
      <div className="mobile-pair">
        <span className="muted">{电脑 ? "那台电脑屏幕上的配对数字应该是" : "手机屏幕上的配对数字应该是"}</span>
        <b data-testid="mobile-pair-code">{当前.配对数字.slice(0, 3)} {当前.配对数字.slice(3)}</b>
        <span className="muted">{电脑 ? "对不上、或者不是你自己在用的电脑，就点「不允许」。" : "对不上就点「不允许」——那不是你的手机。"}</span>
      </div>
    </Modal>
  );
}
