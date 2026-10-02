"use client";
/**
 * 左栏底部那一行「检查更新 · v0.46.14」（2026-10-02，学 usemono.dev 的 MonoCode 左下角）。
 *
 * 原来的更新键（UpdateButton.tsx，已删）只在有新版时才在账号那一行右端冒出一枚圆键：
 * 平时看不见「我现在是哪一版、能不能自己查一下」。这一行常驻，五种样子：
 *   平时      检查更新            v0.46.14   淡的，点了就查（不弹系统对话框，结果就写在这一行）
 *   在查      正在检查…
 *   刚查完    已是最新            （停三秒回到平时）
 *   有新版    更新到 0.46.15      v0.46.14   蓝底，点了开始下载
 *   下载中    下载中 45%          一条进度
 *   下好了    重启以更新到 0.46.15            点了重启；不点的话退出时自动换上
 *   失败      更新失败，点击重试
 * 网页版没有壳的桥，整行不出现。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDownOutlined, ReloadOutlined, WarningOutlined, SyncOutlined, CheckOutlined } from "@ant-design/icons";

/** 壳（desktop/main.js 的 更新状态）推过来的样子，经 preload-app.js 的 window.desktopUpdate */
type 更新状态 = {
  阶段: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "manual" | "error";
  版本?: string;
  进度?: number | null;
  错误?: string;
  地址?: string;
  /** 壳给的一句人话：正在比对 / 差量 2.3 MB / 整包 161 MB。让人看见差量省了什么 */
  文字?: string;
  /** 这一版改了什么（feed 里的 notes），挂在按钮的 title 上 */
  说明?: string;
};

declare global {
  interface Window {
    desktopUpdate?: {
      state(): Promise<更新状态>;
      /** 0.24.2 起才有；托管站的页面可能比壳新，所以调用前要判空 */
      download?(): Promise<void>;
      install(): Promise<void>;
      /** 静默=true：左栏「检查更新」那一行点的，结果它自己显示，壳不弹对话框 */
      check(静默?: boolean): Promise<void>;
      openDownload(): Promise<void>;
      onState(cb: (s: 更新状态) => void): () => void;
    };
  }
}


export default function UpdateRow() {
  const [s, setS] = useState<更新状态 | null>(null);
  const [版本, set版本] = useState<string | null>(null);
  const [刚查完, set刚查完] = useState(false);
  const 上一阶段 = useRef<string | null>(null);

  useEffect(() => {
    const api = window.desktopUpdate;
    if (!api) return;
    const 收 = (x: 更新状态) => {
      // 从「在查」回到「平时」= 查过了、没有新版：说一声「已是最新」，三秒后收回去
      if (上一阶段.current === "checking" && x.阶段 === "idle") set刚查完(true);
      上一阶段.current = x.阶段;
      setS(x);
    };
    const off = api.onState(收);
    api.state().then(收).catch(() => {});
    window.desktopShell?.version().then(set版本).catch(() => {});
    return off;
  }, []);

  useEffect(() => {
    if (!刚查完) return;
    const t = setTimeout(() => set刚查完(false), 3000);
    return () => clearTimeout(t);
  }, [刚查完]);

  const api = typeof window !== "undefined" ? window.desktopUpdate : undefined;
  if (!api || !s) return null;

  const 百分比 = s.进度 == null ? null : Math.max(0, Math.min(100, Math.round(s.进度)));
  const 下载 = () => void (api.download ? api.download() : api.check(true));
  const 查 = () => {
    set刚查完(false);
    void api.check(true);
  };

  let 图标: React.ReactNode = <SyncOutlined />;
  let 话 = "检查更新";
  let 点: (() => void) | undefined = 查;
  let 样式 = "";
  let 进度: number | null | undefined;
  switch (s.阶段) {
    case "checking":
      图标 = <SyncOutlined spin />;
      话 = "正在检查…";
      点 = undefined;
      break;
    case "available":
      图标 = <ArrowDownOutlined />;
      话 = `更新到 ${s.版本}`;
      点 = 下载;
      样式 = " hot";
      break;
    case "downloading":
      图标 = <ArrowDownOutlined />;
      话 = 百分比 != null ? `下载中 ${百分比}%` : "下载中…";
      点 = undefined;
      样式 = " hot";
      进度 = 百分比;
      break;
    case "installing":
      图标 = <SyncOutlined spin />;
      话 = "安装中，马上重启";
      点 = undefined;
      样式 = " hot";
      break;
    case "ready":
      图标 = <ReloadOutlined />;
      话 = `重启以更新到 ${s.版本}`;
      点 = () => void api.install();
      样式 = " hot";
      break;
    case "manual":
      图标 = <ArrowDownOutlined />;
      话 = `去下载 ${s.版本}`;
      点 = () => void api.openDownload();
      样式 = " hot";
      break;
    case "error":
      图标 = <WarningOutlined />;
      话 = "更新失败，点击重试";
      点 = 下载;
      样式 = " warn";
      break;
    default:
      if (刚查完) {
        图标 = <CheckOutlined />;
        话 = "已是最新";
      }
  }

  // 完整那句话放在 title：版本、体积（差量 2.3 MB / 整包 161 MB）、这一版改了什么
  const 提示 = [s.文字, s.说明].filter(Boolean).join("\n") || undefined;
  const 里面 = (
    <>
      <span className="rail-upd-ico" aria-hidden>
        {图标}
      </span>
      <span className="rail-upd-t">{话}</span>
      {版本 && <span className="rail-upd-v">v{版本}</span>}
      {进度 !== undefined && (
        <span className={`rail-upd-bar${进度 == null ? " idle" : ""}`} aria-hidden>
          <i style={进度 != null ? { width: `${进度}%` } : undefined} />
        </span>
      )}
    </>
  );
  return 点 ? (
    <button type="button" className={`rail-upd${样式}`} onClick={点} title={提示}>
      {里面}
    </button>
  ) : (
    <div className={`rail-upd${样式}`} role="status" title={提示}>
      {里面}
    </div>
  );
}
