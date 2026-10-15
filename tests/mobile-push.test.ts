/**
 * 手机版推入推出（src/app/m/push.ts，2026-10-15）：不管怎么折腾，最后都落在「完全进来」或「完全退回」。
 * 用户真机：两页各露一半，停在那儿不动——左边缘按一下没拖、或者手势被 Safari 取消，动画就停在半路。
 * 这里用假的值和假的动画（手动推进），把那几种情况各走一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { 推入, 层样子, 松手去向, type 动画句柄 } from "@/app/m/push";

type 假动画 = { 到: number; 秒: number; 停了: boolean; 完: (() => void)[] };
function 台子() {
  let v = 1;
  const 动画们: 假动画[] = [];
  let 时 = 0;
  const 退完 = vi.fn();
  const 要返回 = vi.fn();
  const 目标变了 = vi.fn();
  const 值 = { get: () => v, set: (x: number) => { v = x; }, jump: (x: number) => { v = x; }, stop: () => {} };
  const 推 = new 推入({
    值,
    动画: (到, 秒): 动画句柄 => {
      const a: 假动画 = { 到, 秒, 停了: false, 完: [] };
      动画们.push(a);
      // 和 motion 一样：被停掉的动画也会回调 then（看控制器会不会因此乱落）
      return { stop: () => { a.停了 = true; a.完.forEach((f) => f()); }, then: (f) => { a.完.push(f); } };
    },
    时长: { 整程: 0.32, 淡: 0.18, 最短: 0.12 },
    退完,
    要返回,
    目标变了,
    现在: () => 时,
  });
  推.设(400, false);
  /** 让最近一个没停的动画走一半 / 走完 */
  const 走一半 = () => { const a = 动画们.filter((x) => !x.停了).at(-1)!; v = (v + a.到) / 2; };
  const 走完 = () => { const a = 动画们.filter((x) => !x.停了).at(-1)!; v = a.到; a.完.forEach((f) => f()); };
  return { 推, 值, get v() { return v; }, set v(x) { v = x; }, 动画们, 退完, 要返回, 目标变了, 走一半, 走完, 拨表: (ms: number) => { 时 += ms; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("推入推出：最后一定落在完整状态", () => {
  it("正常进来、退回：动画跑完落到 0 / 1，退完才卸详情层", () => {
    const t = 台子();
    t.推.去("进来");
    expect(t.动画们[0]).toMatchObject({ 到: 0, 秒: 0.32 });
    t.走完();
    expect(t.v).toBe(0);
    expect(t.推.在动).toBe(false);
    t.推.去("退回");
    t.走一半();
    expect(t.退完).not.toHaveBeenCalled();
    t.走完();
    expect(t.v).toBe(1);
    expect(t.退完).toHaveBeenCalledTimes(1);
    // 界面靠这个让正在退回的详情层不接点击
    expect(t.目标变了.mock.calls).toEqual([["进来"], ["退回"]]);
  });

  it("推入半路按一下左边缘、没拖就松手：接着进来，不停在半路（之前的毛病）", () => {
    const t = 台子();
    t.推.去("进来");
    t.走一半();
    t.推.按下(5);
    expect(t.动画们[0].停了).toBe(true);
    t.推.松手(5);
    expect(t.推.在动).toBe(true);
    t.走完();
    expect(t.v).toBe(0);
  });

  it("推入半路按住左边缘、被系统手势取消：接着进来，也不替它走历史返回", () => {
    const t = 台子();
    t.推.去("进来");
    t.走一半();
    t.推.按下(5);
    t.推.取消();
    t.走完();
    expect(t.v).toBe(0);
    expect(t.要返回).not.toHaveBeenCalled();
  });

  it("右滑一小段松手：弹回；右滑过三分之一松手：退回并走历史返回", () => {
    const t = 台子();
    t.推.去("进来"); t.走完();
    t.推.按下(5); t.拨表(200); t.推.移动(60); t.拨表(200); t.推.松手(60);
    expect(t.推.目标).toBe("进来");
    t.走完();
    expect(t.v).toBe(0);
    t.推.按下(5); t.拨表(200); t.推.移动(200); t.拨表(200); t.推.松手(200);
    expect(t.推.目标).toBe("退回");
    expect(t.要返回).toHaveBeenCalledTimes(1);
    t.走完();
    expect(t.v).toBe(1);
    expect(t.退完).toHaveBeenCalledTimes(1);
  });

  it("右滑没过三分之一但甩得快：退回", () => {
    const t = 台子();
    t.推.去("进来"); t.走完();
    t.推.按下(5); t.拨表(16); t.推.移动(40); t.拨表(16); t.推.移动(80); t.推.松手(80);
    expect(t.推.目标).toBe("退回");
  });

  it("右滑一半时被系统取消：回到进来（Safari 真退了会有 popstate 再叫退回）", () => {
    const t = 台子();
    t.推.去("进来"); t.走完();
    t.推.按下(5); t.推.移动(205);
    expect(t.v).toBeCloseTo(0.5);
    t.推.取消();
    expect(t.推.目标).toBe("进来");
    t.推.去("退回"); // popstate
    t.走完();
    expect(t.v).toBe(1);
    expect(t.要返回).not.toHaveBeenCalled();
  });

  it("退回半路又进来：从当前位置折返；旧动画的收尾不生效（不会把新打开的详情卸掉）", () => {
    const t = 台子();
    t.推.去("进来"); t.走完();
    t.推.去("退回"); t.走一半();
    t.推.去("进来");
    expect(t.动画们.at(-2)!.停了).toBe(true);
    expect(t.退完).not.toHaveBeenCalled();
    expect(t.动画们.at(-1)!.秒).toBeCloseTo(0.16); // 只剩一半路，时长也按一半
    t.走完();
    expect(t.v).toBe(0);
    expect(t.退完).not.toHaveBeenCalled();
  });

  it("同一个目标连叫两次（手势和 popstate 先后到）：不重来", () => {
    const t = 台子();
    t.推.去("进来"); t.走完();
    t.推.去("退回"); t.推.去("退回");
    expect(t.动画们.filter((a) => a.到 === 1)).toHaveLength(1);
  });

  it("动画帧停了（切后台）：到点没完就直接落到目标；切回前台马上落", () => {
    const t = 台子();
    t.推.去("进来"); t.走一半();
    vi.advanceTimersByTime(320 + 400);
    expect(t.v).toBe(0);
    expect(t.推.在动).toBe(false);
    t.推.去("退回"); t.走一半();
    t.推.收尾();
    expect(t.v).toBe(1);
    expect(t.退完).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(t.退完).toHaveBeenCalledTimes(1);
  });

  it("复位（退出登录）：不动画，直接回到没有详情", () => {
    const t = 台子();
    t.推.去("进来"); t.走一半();
    t.推.复位();
    expect(t.v).toBe(1);
    expect(t.推.目标).toBe("退回");
    vi.advanceTimersByTime(2000);
    expect(t.v).toBe(1);
  });

  it("减弱动态效果：时长用淡入淡出那一档", () => {
    const t = 台子();
    t.推.设(400, true);
    t.推.去("进来");
    expect(t.动画们[0].秒).toBe(0.18);
  });
});

describe("两层的样子", () => {
  it("iPhone：进来时上一页往左退 30%、盖一层暗；退回时都归位", () => {
    expect(层样子(0, 400, "ios", false)).toEqual({ 顶x: 0, 顶透明: 1, 底x: -120, 暗: 0.12 });
    expect(层样子(1, 400, "ios", false)).toEqual({ 顶x: 400, 顶透明: 1, 底x: 0, 暗: 0 });
  });
  it("安卓：从右边一小段淡入；减弱动态效果：不位移只淡入淡出", () => {
    expect(层样子(1, 400, "android", false)).toMatchObject({ 顶x: 72, 顶透明: 0 });
    expect(层样子(0.5, 400, "ios", true)).toEqual({ 顶x: 0, 顶透明: 0.5, 底x: 0, 暗: 0 });
  });
  it("松手去向", () => {
    expect([松手去向(0.2, 0), 松手去向(0.4, 0), 松手去向(0.1, 900)]).toEqual(["进来", "退回", "退回"]);
  });
});
