"use client";
/**
 * 桌面端侧栏里那个更新按钮。
 *
 * 壳（Electron 主进程）后台查、后台下，状态经 preload-app.js 的 window.desktopUpdate 推过来，
 * 这里只负责画：下载中是一条灰的进度文字，下完是一个蓝的「重启以更新」，点了就装。
 * 不弹任何对话框——和 Claude Code / Codex 一样。网页版没有这个桥，什么都不画。
 */
import { useEffect, useState } from "react";

type 更新状态 = {
  阶段: "idle" | "checking" | "downloading" | "ready" | "installing" | "manual" | "error";
  版本?: string;
  进度?: number | null;
  错误?: string;
  地址?: string;
};

declare global {
  interface Window {
    desktopUpdate?: {
      state(): Promise<更新状态>;
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
  switch (s.阶段) {
    case "downloading":
      return (
        <div className="rail-update busy" role="status">
          正在下载更新{s.进度 != null ? ` ${s.进度}%` : "…"}
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
        <button type="button" className="rail-update" onClick={() => api?.install()}>
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
        <button type="button" className="rail-update warn" title={s.错误} onClick={() => api?.check()}>
          更新失败，点击重试
        </button>
      );
    default:
      return null;
  }
}
