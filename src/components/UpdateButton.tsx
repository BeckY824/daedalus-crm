"use client";
/**
 * 桌面端侧栏里那个更新按钮。
 *
 * 壳（Electron 主进程）后台查，查到了**不自动下**，状态经 preload-app.js 的 window.desktopUpdate 推过来，
 * 这里只负责画。网页版没有这个桥，什么都不画。
 *
 * **形状照 Codex 那个：它坐在侧栏最下面账号那一行的右端，不自己占一行。**
 * 没有新版时整个组件返回 null——没有更新这件事，界面上就不该有它的位置。
 * 平时是一枚圆的下载键，鼠标放上去才摊开成「更新」两个字；
 * 正在下 / 下完了 / 失败了这三档一直摊着（要你等、要你点、要你重试），但也只写两三个字。
 * **完整那句话在 aria-label 和 tooltip 里**：按钮上的字短，不代表信息可以少。
 * 摊开是 grid 0fr→1fr 的宽度过渡，不量像素也就不会在字长变了之后错位；
 * 状态之间的形变交给 motion 的 layout，和别处一样是 0.18s、小位移、透明度打头，不弹不跳。
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownOutlined, ReloadOutlined, WarningOutlined, SyncOutlined } from "@ant-design/icons";

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

/** 一枚键长什么样：图标、那句话、点了干什么、是否一直摊开 */
type 画法 = {
  图标: React.ReactNode;
  话: string;
  点?: () => void;
  摊开?: boolean;
  样式?: string;
  /** 进度条填到哪儿；null 是「在下但说不出百分比」，画成来回扫的那条 */
  进度?: number | null;
};

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
  const 开始下载 = () => void (api?.download ? api.download() : api?.check());

  /**
   * 壳算出来的百分比在这儿再夹一道。**这是第二道闸，不是修复**——
   * 真正的修复在 desktop/delta.js（分子分母单位对不上，会一路涨过 100%）。
   * 但进度条是拿它当宽度画的，一个坏数字会把那条线画到按钮外面去，
   * 而按钮不该因为上游算错就画坏。
   */
  const 百分比 = s.进度 == null ? null : Math.max(0, Math.min(100, Math.round(s.进度)));

  const 画: 画法 | null = (() => {
    switch (s.阶段) {
      case "available":
        return {
          // 只说版本。「差量 2.3 MB」留给 title 和下载中那一屏——
          // 侧栏 220 宽，两样都塞进去的话尾巴会被裁掉，反而谁也没看清
          图标: <ArrowDownOutlined />,
          话: "更新",
          点: 开始下载,
        };
      case "downloading":
        return {
          图标: <ArrowDownOutlined />,
          话: 百分比 != null ? `${百分比}%` : "下载中",
          摊开: true,
          样式: "busy",
          进度: 百分比,
        };
      case "installing":
        return { 图标: <SyncOutlined spin />, 话: "安装中", 摊开: true, 样式: "busy" };
      case "ready":
        return { 图标: <ReloadOutlined />, 话: "重启", 点: () => void api?.install(), 摊开: true };
      case "manual":
        return { 图标: <ArrowDownOutlined />, 话: "去下载", 点: () => void api?.openDownload(), 摊开: true };
      case "error":
        return { 图标: <WarningOutlined />, 话: "重试", 点: 开始下载, 摊开: true, 样式: "warn" };
      default:
        return null;
    }
  })();

  if (!画) return null;
  const 静态 = !画.点;
  const 类名 = `rail-up${画.摊开 ? " open" : ""}${画.样式 ? ` ${画.样式}` : ""}`;
  /**
   * 按钮上的字短，是因为它坐在账号那一行的右端，只有一小条空间。
   * 但**说的话不能跟着变少**：读屏念的是完整那句，鼠标停住看到的是版本、体积、这一版改了什么。
   */
  const 全称: Record<string, string> = {
    available: `有新版本 ${s.版本}，点击开始下载`,
    downloading: `正在下载 ${s.版本}${s.进度 != null ? `，已完成 ${s.进度}%` : ""}`,
    installing: "正在安装，马上重启",
    ready: `${s.版本} 已准备好：点击现在重启；不点的话退出时自动换上，下次打开就是新版`,
    manual: `有新版本 ${s.版本}，点击去下载页`,
    error: "更新失败，点击重试",
  };
  const 提示 = [全称[s.阶段], s.文字, s.说明].filter(Boolean).join("\n");
  const 无障碍 = { "aria-label": 全称[s.阶段] ?? 画.话, title: 提示 || undefined };

  const 里面 = (
    <>
      <span className="rail-up-ico" aria-hidden>
        {画.图标}
      </span>
      {/* 0fr → 1fr：不量像素的宽度过渡。里面那层 overflow:hidden 负责把字裁住 */}
      <span className="rail-up-lab">
        <span>{画.话}</span>
      </span>
      {/* 进度那一排刻度。样式在 globals.css 的 .rail-up-bar——它已经不是"一条"了，
          但类名留着：改名要动三处，而这行字比类名更能说明它是什么 */}
      {画.进度 !== undefined && (
        <span
          className={`rail-up-bar${画.进度 == null ? " idle" : ""}`}
          style={画.进度 != null ? ({ "--p": `${画.进度}%` } as React.CSSProperties) : undefined}
          aria-hidden
        />
      )}
    </>
  );

  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.div
        key={s.阶段}
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.18 }}
        className="rail-up-slot"
      >
        {静态 ? (
          <div className={类名} role="status" {...无障碍}>
            {里面}
          </div>
        ) : (
          <button type="button" className={类名} onClick={画.点} {...无障碍}>
            {里面}
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
