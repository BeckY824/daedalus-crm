"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart, BarChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export default function Chart({
  option,
  height = 260,
  点一段,
}: {
  option: EChartsCoreOption;
  height?: number | string;
  /**
   * 点柱子 / 点数据点时回调，参数是它在 series data 里的下标。
   * 给了它，鼠标移上去才变成手型——一个点不出东西的图表不该假装能点
   * （设计稿 09/DATA·YEAR 的页面规则：图表提供查看明细）。
   */
  点一段?: (下标: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  /**
   * 回调放 ref 里：echarts 的事件只在初始化那次挂一遍，
   * 直接闭包住 props 的话，父组件重渲染之后点到的还是第一次那个函数。
   * 赋值必须在 effect 里做——渲染期间写 ref 会被 react-hooks 拦下，
   * 而且并发渲染下那次渲染可能被丢弃，写进去的是个没上屏的值。
   */
  const 回调 = useRef(点一段);
  useEffect(() => {
    回调.current = 点一段;
  });

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current);
    inst.current = c;
    /*
      两种点法都算：点柱子本身，和点它下面的横轴刻度。
      只认柱子的话，矮柱子和窄柱子几乎点不中——一个「理论上能点」的图表
      和点不动的图表对用户是一回事。横轴刻度要 xAxis.triggerEvent 才会发事件，
      它没有 dataIndex，只有 value，所以反查一下它在 category 里的位置。
    */
    c.on("click", (e: { componentType?: string; dataIndex?: number; value?: unknown }) => {
      if (e.componentType === "xAxis") {
        const 刻度 = (c.getOption() as { xAxis?: { data?: unknown[] }[] }).xAxis?.[0]?.data ?? [];
        const i = 刻度.indexOf(e.value);
        if (i >= 0) 回调.current?.(i);
        return;
      }
      if (typeof e.dataIndex === "number") 回调.current?.(e.dataIndex);
    });
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    inst.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height, cursor: 点一段 ? "pointer" : undefined }} />;
}

/** 设计稿里指标卡右下角那种迷你趋势线 */
export function Sparkline({
  data,
  color = "#1668dc",
  height = 44,
}: {
  data: number[];
  color?: string;
  height?: number;
}) {
  const option: EChartsCoreOption = {
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: "category", show: false, boundaryGap: false },
    yAxis: { type: "value", show: false, min: "dataMin", max: "dataMax" },
    series: [
      {
        type: "line",
        data,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: color + "40" },
              { offset: 1, color: color + "00" },
            ],
          },
        },
      },
    ],
  };
  return <Chart option={option} height={height} />;
}
