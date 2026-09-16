"use client";
/**
 * 桌面端侧栏里那个更新按钮。
 *
 * 壳（Electron 主进程）后台查，查到了**不自动下**，状态经 preload-app.js 的 window.desktopUpdate 推过来，
 * 这里只负责画：查到新版是一个蓝的「更新到 x · 差量 2.3 MB」，点了才开始下；下载中是一条灰的进度文字；
 * 下完变成「重启以更新」，点了就装。不弹任何对话框。网页版没有这个桥，什么都不画。
 */
import { useEffect, useState } from "react";

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
      check(): Promise<void>;
      openDownload(): Promise<void>;
      onState(cb: (s: 更新状态) => void): () => void;
    };
  }
}

export default function UpdateButton() {
  const [s, setS] = useState<更新状态 | null>(null);

  useEffect(() => {
    const api = window.desktopUpdate;
    if (!api) return;
    const off = api.onState(setS);
    api.state().then(setS).catch(() => {});
    return off;
  }, []);

  if (!s) return null;
  const api = window.desktopUpdate;
  // 老壳（0.24.1 及以前）没有 download，那时壳是自动下的，按钮退回「检查更新」也能把流程走起来
  const 开始下载 = () => (api?.download ? api.download() : api?.check());
  switch (s.阶段) {
    case "available":
      return (
        <button type="button" className="rail-update" onClick={开始下载} title={s.说明}>
          更新到 {s.版本}
          {s.文字 ? ` · ${s.文字}` : ""}
        </button>
      );
    case "downloading":
      return (
        <div className="rail-update busy" role="status">
          {s.文字 ?? "正在下载更新"}
          {s.进度 != null ? ` ${s.进度}%` : "…"}
        </div>
      );
    case "installing":
      return (
        <div className="rail-update busy" role="status">
          正在安装，马上重启…
        </div>
      );
    case "ready":
      return (
        <button type="button" className="rail-update" onClick={() => api?.install()} title={s.文字}>
          重启以更新到 {s.版本}
        </button>
      );
    case "manual":
      return (
        <button type="button" className="rail-update" onClick={() => api?.openDownload()}>
          有新版本 {s.版本}，去下载
        </button>
      );
    case "error":
      return (
        <button type="button" className="rail-update warn" title={s.错误} onClick={开始下载}>
          更新失败，点击重试
        </button>
      );
    default:
      return null;
  }
}
