"use client";

import type { EChartsCoreOption } from "echarts/core";
import type { 设备分布 } from "@/lib/device-os";

/**
 * 运营台几页共用的小件。颜色全走 ops.css 里的变量；图表那边 echarts 不认 CSS 变量，
 * 所以同一组色值在下面 色 里再写一遍——**两处要一起改**（和 Rise.tsx 的 缓动 一个道理）。
 */
export const 色 = {
  蓝: "#2a78d6",
  深蓝: "#1c5cab",
  橙: "#eb6834",
  灰点: "#b8c1cf",
  线: "#eef2f8",
  轴: "#e3e9f2",
  字: "#3d4b60",
  淡字: "#6f7d92",
  墨: "#0f1c2e",
};

export const 千分位 = (n: number) => n.toLocaleString("zh-CN");

/** 「三天前」比一串时间戳好认——运营台是扫一眼的地方，不是查档的地方 */
export function 何时(iso: string | null): string {
  if (!iso) return "—";
  const 分 = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (分 < 1) return "刚刚";
  if (分 < 60) return `${分} 分钟前`;
  const 时 = Math.floor(分 / 60);
  if (时 < 24) return `${时} 小时前`;
  const 天 = Math.floor(时 / 24);
  if (天 === 1) return "昨天";
  if (天 < 30) return `${天} 天前`;
  return iso.slice(0, 10);
}

/** 一格数：上面是名字，大字是数，下面一行是**口径**——没有口径的数没人敢拿它做决定 */
export function Kpi({ 名, 数, 尾, 注, icon, 警, 静 }: { 名: string; 数: number | string; 尾?: string; 注: React.ReactNode; icon?: React.ReactNode; 警?: boolean; 静?: boolean }) {
  return (
    <div className={`opx-kpi${警 ? " opx-kpi-warn" : ""}${静 ? " opx-kpi-quiet" : ""}`}>
      <div className="opx-kpi-k">
        {icon}
        {名}
      </div>
      <div className="opx-kpi-v">
        {typeof 数 === "number" ? 千分位(数) : 数}
        {尾 && <i>{尾}</i>}
      </div>
      <div className="opx-kpi-n">{注}</div>
    </div>
  );
}

export function 卡片({ 标题, 说明, 右, 平, children, style }: { 标题?: React.ReactNode; 说明?: React.ReactNode; 右?: React.ReactNode; 平?: boolean; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section className={`opx-card${平 ? " opx-card-flush" : ""}`} style={style}>
      {(标题 || 右) && (
        <div className="opx-card-h">
          {标题 && <h2>{标题}</h2>}
          {说明 && <span>{说明}</span>}
          {右 && <div className="opx-card-r">{右}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** AI 次数：一条细条 + 「剩 / 送」。一条走到头的红条不用读就知道出事了 */
export function 次数条({ 剩, 送 }: { 剩: number; 送: number }) {
  if (送 === 0 && 剩 === 0) return <span className="opx-faint">—</span>;
  const 比 = 送 > 0 ? Math.max(0, Math.min(1, 剩 / 送)) : 0;
  const 档 = 剩 === 0 ? " opx-meter-out" : 比 <= 0.2 ? " opx-meter-low" : "";
  return (
    <span className={`opx-meter${档}`} title={`还剩 ${剩} 次，一共送过 ${送} 次`}>
      <span className="opx-meter-bar" aria-hidden>
        <i style={{ width: `${比 * 100}%` }} />
      </span>
      <span className="opx-meter-t">
        {剩} <s>/ {送}</s>
      </span>
    </span>
  );
}

export function 头像({ 名, 大 }: { 名: string; 大?: boolean }) {
  return (
    <span className={`opx-av${大 ? " opx-av-lg" : ""}`} aria-hidden>
      {(名 || "?").trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

const 系统类 = (s: string) => (s === "Mac" ? "opx-os opx-os-mac" : s === "Windows" ? "opx-os opx-os-win" : "opx-os");

export function 系统({ 名 }: { 名: string }) {
  return <span className={系统类(名)}>{名}</span>;
}

/** 「Mac 1 · Windows 1」：每种一个色点 + 名字 + 台数；一台都没有就一道横 */
export function 系统们({ 分 }: { 分: 设备分布 }) {
  const 有 = (["Mac", "Windows", "Linux", "未知"] as const).filter((k) => 分[k] > 0);
  if (有.length === 0) return <span className="opx-faint">—</span>;
  return (
    <span className="opx-oss">
      {有.map((k) => (
        <span key={k} className={系统类(k)}>
          {k} {分[k]}
        </span>
      ))}
    </span>
  );
}

/**
 * 设备系统的分段条。段之间 2px 白缝，下面每段一个图例（名字 + 台数 + 占比）——不靠颜色认。
 * 「未知」用灰，不占一个类别色：它不是一种系统，是还没报上来的那一批。
 */
export function 系统分段({ 分 }: { 分: 设备分布 }) {
  const 段 = [
    { 名: "Mac", 数: 分.Mac, 色: 色.蓝 },
    { 名: "Windows", 数: 分.Windows, 色: 色.橙 },
    ...(分.Linux ? [{ 名: "Linux", 数: 分.Linux, 色: "#1baf7a" }] : []),
    { 名: "未知", 数: 分.未知, 色: 色.灰点 },
  ];
  const 共 = 段.reduce((s, x) => s + x.数, 0);
  if (共 === 0) return <div className="opx-empty">还没有设备</div>;
  return (
    <div>
      <div className="opx-split" role="img" aria-label={段.map((x) => `${x.名} ${x.数} 台`).join("，")}>
        {段.filter((x) => x.数 > 0).map((x) => (
          <i key={x.名} style={{ width: `${(x.数 / 共) * 100}%`, background: x.色 }} title={`${x.名} ${x.数} 台`} />
        ))}
      </div>
      <div className="opx-split-legend">
        {段.map((x) => (
          <div key={x.名}>
            <span className={系统类(x.名)}>{x.名}</span>
            <b>{x.数}</b>
            <span className="opx-muted" style={{ fontSize: 12 }}>
              {Math.round((x.数 / 共) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const 月日 = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;

/**
 * 按天的柱图（单一系列，所以不摆图例——标题就是它的名字）。
 * 细柱、柱头 4px 圆角、网格线很浅；悬停给日期、次数和 token。
 */
export function 按天柱图(数据: { 日: string; 数: number; token?: number }[], 单位 = "次"): EChartsCoreOption {
  return {
    grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(42,120,214,0.06)" } },
      backgroundColor: "#fff",
      borderColor: 色.轴,
      textStyle: { color: 色.墨, fontSize: 12 },
      formatter: (ps: { dataIndex: number }[]) => {
        const x = 数据[ps[0]?.dataIndex ?? 0];
        if (!x) return "";
        const 附 = x.token != null ? `<br/><span style="color:${色.淡字}">${千分位(x.token)} token</span>` : "";
        return `${月日(x.日)}<br/><b>${千分位(x.数)}</b> ${单位}${附}`;
      },
    },
    xAxis: {
      type: "category",
      data: 数据.map((x) => x.日.slice(5).replace("-", "/")),
      axisLine: { lineStyle: { color: 色.轴 } },
      axisTick: { show: false },
      axisLabel: { color: 色.淡字, fontSize: 11, interval: Math.max(0, Math.ceil(数据.length / 8) - 1) },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      splitLine: { lineStyle: { color: 色.线 } },
      axisLabel: { color: 色.淡字, fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: 数据.map((x) => x.数),
        barMaxWidth: 10,
        barCategoryGap: "45%",
        itemStyle: { color: 色.蓝, borderRadius: [4, 4, 0, 0] },
        emphasis: { itemStyle: { color: 色.深蓝 } },
      },
    ],
  };
}

/**
 * 横条（按类别比多少：功能、版本、模型）。数直接标在条尾，字用正文色，不用系列色。
 * 最多的在最上面。
 */
export function 横条图(数据: { 名: string; 数: number }[], 单位 = "次"): EChartsCoreOption {
  const 倒 = [...数据].reverse();
  return {
    grid: { left: 4, right: 48, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      backgroundColor: "#fff",
      borderColor: 色.轴,
      textStyle: { color: 色.墨, fontSize: 12 },
      formatter: (p: { name: string; value: number }) => `${p.name}<br/><b>${千分位(p.value)}</b> ${单位}`,
    },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: 倒.map((x) => x.名),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: 色.字, fontSize: 12 },
    },
    series: [
      {
        type: "bar",
        data: 倒.map((x) => x.数),
        barMaxWidth: 10,
        showBackground: true,
        backgroundStyle: { color: 色.线, borderRadius: [0, 4, 4, 0] },
        itemStyle: { color: 色.蓝, borderRadius: [0, 4, 4, 0] },
        emphasis: { itemStyle: { color: 色.深蓝 } },
        label: { show: true, position: "right", color: 色.字, fontSize: 12, formatter: (p: { value: number }) => 千分位(p.value) },
      },
    ],
  };
}
