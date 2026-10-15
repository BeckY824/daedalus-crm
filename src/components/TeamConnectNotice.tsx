"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { App, Button } from "antd";
import { 待连接团队动作 } from "@/app/(app)/settings/team-actions";

/**
 * 新电脑登录同一个账号（2026-10-15 多设备同步）：账号在云上是团队成员、这台还没连上，
 * 原来打开就是一片空白、什么提示都没有。打开应用时问一次，是就在右上角提醒一句、点一下去「设置 → 团队」连接。
 * 一次打开只提醒一次（关掉了就不再弹；设置 → 团队里一直有那张卡片）。只在桌面端本地模式挂（layout.tsx）。
 */
export default function TeamConnectNotice() {
  const { notification } = App.useApp();
  const router = useRouter();
  useEffect(() => {
    let 停 = false;
    try { if (sessionStorage.getItem("daedalus:team-connect-noticed")) return; } catch { /* 读不了就照常问 */ }
    void 待连接团队动作().then((r) => {
      if (停 || !r) return;
      try { sessionStorage.setItem("daedalus:team-connect-noticed", "1"); } catch { /* 只是少弹一次 */ }
      notification.info({
        key: "team-connect",
        title: `你的账号在团队「${r.团名}」里，这台电脑还没连上`,
        description: "在你另一台已连上的电脑或手机上点一下「允许」，这台就开始同步客户和跟进。",
        actions: <Button type="primary" size="small" onClick={() => { notification.destroy("team-connect"); router.push("/settings?tab=team"); }}>去连接</Button>,
        duration: 0,
      });
    }).catch(() => undefined);
    return () => { 停 = true; };
  }, [notification, router]);
  return null;
}
