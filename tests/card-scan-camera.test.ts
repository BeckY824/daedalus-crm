/**
 * 扫名片「点了没反应」（2026-10-20 客户反馈）：click() 之后 1.5 秒内既没选好 / 取消，页面也没失焦、没切后台，
 * 就当相机没打开，给提示和「从相册选」；不到 0.8 秒就 cancel、页面又没失焦（秒退）也算。这里只测这个判断（lib/card-scan/camera.ts 盯相机），真点相机在 e2e 里
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { 盯相机, 等相机毫秒, 秒退毫秒 } from "@/lib/card-scan/camera";

describe("相机没打开的判断", () => {
  let 盯: { 输入框: EventTarget; 窗口: EventTarget; 文档: EventTarget };
  beforeEach(() => {
    vi.useFakeTimers();
    盯 = { 输入框: new EventTarget(), 窗口: new EventTarget(), 文档: new EventTarget() };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("等的是 1.5 秒", () => {
    expect(等相机毫秒).toBe(1500);
  });

  it("1.5 秒里一点动静都没有：算没打开，只报一次", () => {
    const 没开 = vi.fn();
    盯相机(盯, 没开);
    vi.advanceTimersByTime(1499);
    expect(没开).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(没开).toHaveBeenCalledTimes(1);
    // 之后再来事件、再等也不重复报
    盯.窗口.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(5000);
    expect(没开).toHaveBeenCalledTimes(1);
  });

  for (const [谁, 事件] of [
    ["输入框", "change"], ["输入框", "cancel"],
    ["窗口", "blur"], ["窗口", "pagehide"], ["文档", "visibilitychange"],
  ] as const) {
    it(`0.8～1.5 秒内${谁}有 ${事件}：相机 / 选图界面出来过，不算没打开`, () => {
      const 没开 = vi.fn();
      盯相机(盯, 没开);
      vi.advanceTimersByTime(800);
      盯[谁].dispatchEvent(new Event(事件));
      vi.advanceTimersByTime(5000);
      expect(没开).not.toHaveBeenCalled();
    });
  }

  it("秒退：点完不到 0.8 秒就 cancel、页面没失焦（系统界面没出来，Chromium / 安卓内置浏览器打不开选图框就这样）→ 马上算没打开", () => {
    expect(秒退毫秒).toBe(800);
    const 没开 = vi.fn();
    盯相机(盯, 没开);
    vi.advanceTimersByTime(100);
    盯.输入框.dispatchEvent(new Event("cancel"));
    expect(没开).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(没开).toHaveBeenCalledTimes(1);
  });

  it("先失焦再 cancel（相机出来过、人点了取消）：再快也不算没打开", () => {
    const 没开 = vi.fn();
    盯相机(盯, 没开);
    vi.advanceTimersByTime(100);
    盯.窗口.dispatchEvent(new Event("blur"));
    盯.输入框.dispatchEvent(new Event("cancel"));
    vi.advanceTimersByTime(5000);
    expect(没开).not.toHaveBeenCalled();
  });

  it("1.5 秒之后才来的动静不改结论（已经报过没打开）", () => {
    const 没开 = vi.fn();
    盯相机(盯, 没开);
    vi.advanceTimersByTime(1600);
    盯.输入框.dispatchEvent(new Event("change"));
    expect(没开).toHaveBeenCalledTimes(1);
  });

  it("提前不盯了（又点了一次、照片已经回来）：不报，也不再挂着监听", () => {
    const 没开 = vi.fn();
    const 不盯 = 盯相机(盯, 没开);
    const 摘 = vi.spyOn(盯.窗口, "removeEventListener");
    不盯();
    vi.advanceTimersByTime(5000);
    expect(没开).not.toHaveBeenCalled();
    expect(摘).toHaveBeenCalledWith("blur", expect.any(Function));
    不盯(); // 收两次不出错
  });

  it("别的事件（focus、resize）不算动静", () => {
    const 没开 = vi.fn();
    盯相机(盯, 没开);
    盯.窗口.dispatchEvent(new Event("focus"));
    盯.窗口.dispatchEvent(new Event("resize"));
    盯.输入框.dispatchEvent(new Event("click"));
    vi.advanceTimersByTime(1500);
    expect(没开).toHaveBeenCalledTimes(1);
  });
});
