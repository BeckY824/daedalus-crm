"use client";

/**
 * 会花 AI 次数的地方，界面上怎么说。一个 Provider、两个件：
 *
 *   <AiCost />       挂在按钮里的小角标「1 次」。起草话术、起草邀请、AI 解析、盯盘解读、重新回答……
 *                    **所有会调模型、会花次数的按钮都挂它**，别在按钮旁边各写一句
 *   <AiRemaining />  首页和 ⌘J 面板输入框下那行淡字「免费次数还剩 N 次 · 每问用 1 次」
 *
 * 规矩（2026-09-18 拍板「AI 不许自动跑」那条）：按钮旁边写明它要花掉几次。
 * 在这之前只有「生成简报」和「粘贴切分」写了「会用掉 1 次」，别的十来个按钮点下去才知道——
 * 免费额度就 30 次，随手点几个「起草」就去了一截（2026-09-28 交互审查 M5）。
 *
 * **只对真会花的人说**：填了自己 Key 的、付费的、自部署的一次都不扣，
 * 对他们写「1 次」是一句在他那儿不成立的话——计不计次的判断在 lib/ai-meter.ts，别在组件里猜。
 * 没被 Provider 包住时（单测、布局外）一律当不计次：宁可少说一句，不说错话。
 *
 * 余额怎么保持新鲜：布局给初值（托管版带着数，桌面端的要联网所以是 null），
 * 页面出来以后问一次 /api/ai/meter；之后**任何一个 AI 任务跑完**（lib/ai-jobs 里正在跑的数变少）再问一次。
 * 这样每个按钮不用各自记得去刷新。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRunningCount } from "@/lib/ai-jobs";
import type { AI计次 } from "@/lib/ai-meter";

const 不计次: AI计次 = { 计次: false, 还剩: null, 上限: null };
const Ctx = createContext<AI计次>(不计次);

export function AiMeterProvider({ 初值, children }: { 初值: AI计次; children: React.ReactNode }) {
  const [值, set值] = useState(初值);
  const 跑着 = useRunningCount();
  const 上一次 = useRef<number | null>(null);

  const 问 = useCallback(() => {
    fetch("/api/ai/meter", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<AI计次>) : null))
      .then((d) => {
        // 问不到数（断网）就别拿 null 把已知的数冲掉
        if (d && (d.还剩 !== null || !d.计次)) set值(d);
      })
      .catch(() => {
        /* 问不到就维持原样：角标照挂，那行字不带数 */
      });
  }, []);

  // 托管版布局已经带着数来了，不必再问；桌面端的数要联网，布局没问，页面出来以后问一次
  useEffect(() => {
    if (初值.计次 && 初值.还剩 === null) 问();
  }, [初值.计次, 初值.还剩, 问]);

  // 任何一个 AI 任务跑完（正在跑的数变少了）：刚花掉一次，再问一遍还剩几次
  useEffect(() => {
    const 上 = 上一次.current;
    上一次.current = 跑着;
    if (初值.计次 && 上 !== null && 跑着 < 上) 问();
  }, [跑着, 初值.计次, 问]);

  return <Ctx.Provider value={值}>{children}</Ctx.Provider>;
}

export function useAiMeter(): AI计次 {
  return useContext(Ctx);
}

/** 按钮里的「1 次」。不计次的人什么都不显示 */
export default function AiCost({ 次 = 1 }: { 次?: number }) {
  const { 计次 } = useAiMeter();
  if (!计次) return null;
  return (
    <span className="ai-cost" title={`会用掉 ${次} 次 AI 额度`}>
      {次} 次
    </span>
  );
}

/** 输入框下那行淡字。不计次的人不显示；数问不到时只说「每问用 1 次」 */
export function AiRemaining() {
  const { 计次, 还剩 } = useAiMeter();
  if (!计次) return null;
  if (还剩 === null) return <span className="cli-quota">每问用 1 次 AI 额度</span>;
  return (
    <span className={`cli-quota${还剩 === 0 ? " cli-quota-out" : 还剩 <= 2 ? " cli-quota-low" : ""}`}>
      免费次数还剩 {还剩} 次 · 每问用 1 次
    </span>
  );
}

/**
 * 左栏底部那条用量（2026-10-02，学 MonoCode 左下角那条）：本月 AI 次数还剩多少，一眼看见，
 * 不用等到输入框下面那行字变红才知道快用完了。不计次的人（自己的 Key、付费、自部署）不显示；
 * 数还没问到时也不显示——画一条空槽比不画更容易被读成「用完了」。
 */
/**
 * 只写「还剩几次」，不写「/ 共几次」（2026-10-03 走查）。「共」是赠送之和，每日赠送是用的时候才结的：
 * 新号首屏 30 / 30，用一次变成 32 / 33——分母自己涨，看着像算错了。
 * 条按开户那 30 次画满格，多出来的（当天补的几次）也只是满格，不往外溢。
 * 和 lib/tenant/credits.ts 的 注册赠送 是同一个数；那边是服务端文件，客户端引不进来
 */
const 满格 = 30;

export function AiMeterBar() {
  const { 计次, 还剩, 上限 } = useAiMeter();
  if (!计次 || 还剩 === null || !上限) return null;
  const 比 = Math.max(0, Math.min(1, 还剩 / 满格));
  const 档 = 还剩 === 0 ? " out" : 还剩 <= 2 ? " low" : "";
  return (
    <div className={`rail-meter${档}`} title={`AI 免费次数还剩 ${还剩} 次，每问用 1 次`}>
      <div className="rail-meter-row">
        <span>AI 次数</span>
        <b>还剩 {还剩} 次</b>
      </div>
      <div className="rail-meter-bar" role="meter" aria-label="AI 免费次数" aria-valuemin={0} aria-valuemax={满格} aria-valuenow={Math.min(还剩, 满格)}>
        <span style={{ width: `${比 * 100}%` }} />
      </div>
    </div>
  );
}
