/**
 * 扫名片「点了没反应」（2026-10-20 客户反馈）：click() 之后 1.5 秒内既没选好 / 取消，页面也没失焦、没切后台，
 * 就当相机没打开，给提示和「从相册选」；不到 0.8 秒就 cancel、页面又没失焦（秒退）也算；
 * 失焦了但没切后台就 cancel（安卓没相机权限）也算，苹果除外；
 * 报过之后 change / cancel 才回来（iPhone Safari 不发失焦）就收回提示。这里只测这个判断（lib/card-scan/camera.ts 盯相机），真点相机在 e2e 里
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { 盯相机, 等相机毫秒, 秒退毫秒, 换浏览器提示, 推荐浏览器的话 } from "@/lib/card-scan/camera";
import { 认浏览器 } from "@/app/m/ui";

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
    盯相机(盯, { 没开 });
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
      盯相机(盯, { 没开 });
      vi.advanceTimersByTime(800);
      盯[谁].dispatchEvent(new Event(事件));
      vi.advanceTimersByTime(5000);
      expect(没开).not.toHaveBeenCalled();
    });
  }

  it("秒退：点完不到 0.8 秒就 cancel、页面没失焦（系统界面没出来，Chromium / 安卓内置浏览器打不开选图框就这样）→ 马上算没打开", () => {
    expect(秒退毫秒).toBe(800);
    const 没开 = vi.fn();
    盯相机(盯, { 没开 });
    vi.advanceTimersByTime(100);
    盯.输入框.dispatchEvent(new Event("cancel"));
    expect(没开).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(没开).toHaveBeenCalledTimes(1);
  });

  it("失焦了、没切后台就 cancel（安卓 Chrome 没相机权限：权限框选「不允许」或之前选过不再询问）→ 算没打开", () => {
    const 没开 = vi.fn();
    盯相机(盯, { 没开 });
    vi.advanceTimersByTime(800);
    盯.窗口.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(5000); // 失焦了就不按 1.5 秒报，等 cancel
    expect(没开).not.toHaveBeenCalled();
    盯.输入框.dispatchEvent(new Event("cancel"));
    expect(没开).toHaveBeenCalledTimes(1);
  });

  it("失焦 → 切后台 → cancel（相机真开了、人点了取消）：不算没打开", () => {
    for (const 后台 of [["文档", "visibilitychange"], ["窗口", "pagehide"]] as const) {
      const 没开 = vi.fn();
      盯相机(盯, { 没开 });
      盯.窗口.dispatchEvent(new Event("blur"));
      vi.advanceTimersByTime(3000);
      盯[后台[0]].dispatchEvent(new Event(后台[1]));
      vi.advanceTimersByTime(20_000);
      盯.输入框.dispatchEvent(new Event("cancel"));
      expect(没开, 后台[1]).not.toHaveBeenCalled();
    }
  });

  it("失焦后选好了（change）：不算没打开", () => {
    const 没开 = vi.fn();
    盯相机(盯, { 没开 });
    盯.窗口.dispatchEvent(new Event("blur"));
    盯.输入框.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(5000);
    expect(没开).not.toHaveBeenCalled();
  });

  it("苹果不套「失焦就退」：先失焦再 cancel 不算没打开", () => {
    const 没开 = vi.fn();
    盯相机(盯, { 没开 }, { 苹果: true });
    vi.advanceTimersByTime(100);
    盯.窗口.dispatchEvent(new Event("blur"));
    盯.输入框.dispatchEvent(new Event("cancel"));
    vi.advanceTimersByTime(5000);
    expect(没开).not.toHaveBeenCalled();
  });

  it("自带选择框（夸克：点了先弹自己的「相机拍照 / 手机相册」，什么事件都没有）：不按 1.5 秒报，人选完照常", () => {
    const 没开 = vi.fn();
    盯相机(盯, { 没开 }, { 自带选择框: true });
    vi.advanceTimersByTime(20_000);
    expect(没开).not.toHaveBeenCalled();
    盯.文档.dispatchEvent(new Event("visibilitychange")); // 选了相机拍照
    盯.输入框.dispatchEvent(new Event("change"));
    expect(没开).not.toHaveBeenCalled();
  });

  it("报过没打开之后 change / cancel 才回来（iPhone Safari：相机盖上来不发失焦，拍完 / 取消才回）→ 回来了，收提示", () => {
    for (const 回 of ["change", "cancel"]) {
      const 没开 = vi.fn(), 回来了 = vi.fn();
      盯相机(盯, { 没开, 回来了 });
      vi.advanceTimersByTime(1500);
      expect(没开).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20_000);
      盯.输入框.dispatchEvent(new Event(回));
      expect(回来了, 回).toHaveBeenCalledTimes(1);
      盯.输入框.dispatchEvent(new Event(回));
      expect(回来了, `${回} 只报一次`).toHaveBeenCalledTimes(1);
    }
  });

  it("报过没打开之后的失焦、切后台不算回来（人可能是切去设置开权限了）", () => {
    const 没开 = vi.fn(), 回来了 = vi.fn();
    盯相机(盯, { 没开, 回来了 });
    vi.advanceTimersByTime(1600);
    盯.窗口.dispatchEvent(new Event("blur"));
    盯.文档.dispatchEvent(new Event("visibilitychange"));
    expect(回来了).not.toHaveBeenCalled();
    expect(没开).toHaveBeenCalledTimes(1);
  });

  it("秒退不算回来：提示留着", () => {
    const 没开 = vi.fn(), 回来了 = vi.fn();
    盯相机(盯, { 没开, 回来了 });
    vi.advanceTimersByTime(100);
    盯.输入框.dispatchEvent(new Event("cancel"));
    vi.advanceTimersByTime(5000);
    expect(没开).toHaveBeenCalledTimes(1);
    expect(回来了).not.toHaveBeenCalled();
  });

  it("提前不盯了（又点了一次、照片已经回来）：不报，也不再挂着监听", () => {
    const 没开 = vi.fn();
    const 不盯 = 盯相机(盯, { 没开 });
    const 摘 = vi.spyOn(盯.窗口, "removeEventListener");
    不盯();
    vi.advanceTimersByTime(5000);
    expect(没开).not.toHaveBeenCalled();
    expect(摘).toHaveBeenCalledWith("blur", expect.any(Function));
    不盯(); // 收两次不出错
  });

  it("别的事件（focus、resize）不算动静", () => {
    const 没开 = vi.fn();
    盯相机(盯, { 没开 });
    盯.窗口.dispatchEvent(new Event("focus"));
    盯.窗口.dispatchEvent(new Event("resize"));
    盯.输入框.dispatchEvent(new Event("click"));
    vi.advanceTimersByTime(1500);
    expect(没开).toHaveBeenCalledTimes(1);
  });
});

/**
 * 扫名片支持哪些浏览器（2026-10-20 定）：10-15 真机全流程过的不提示，别的推荐换 Edge（安卓）/ Safari（iPhone）。
 * UA 走 认浏览器()，和页面上一样
 */
describe("扫名片推荐浏览器", () => {
  const 安卓 = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)";
  const 苹果 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const 支持: [string, string][] = [
    ["iPhone Safari", `${苹果} Version/18.0 Mobile/15E148 Safari/604.1`],
    ["安卓 Chrome", `${安卓} Chrome/130.0.0.0 Mobile Safari/537.36`],
    ["安卓 Edge", `${安卓} Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0`],
    ["安卓微信", `${安卓} Chrome/130.0.0.0 Mobile Safari/537.36 XWEB/1300 MMWEBSDK/20240301 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64`],
    ["iPhone 微信", `${苹果} Mobile/15E148 MicroMessenger/8.0.50(0x1800322e) NetType/WIFI Language/zh_CN`],
    ["华为浏览器", `${安卓} Chrome/114.0.0.0 HuaweiBrowser/17.0.0.300 Mobile Safari/537.36`],
    ["QQ 浏览器", `${安卓} Chrome/109.0.5414.86 MQQBrowser/20.6 Mobile Safari/537.36`],
    ["夸克", `${安卓} Chrome/100.0.4896.58 UWS/3.22.2.66 Mobile Safari/537.36 UCBS/3.22.2.66_231225161600 ChannelId(1) NebulaSDK/1.8.100112 Nebula AlipayDefined(nt:WIFI,ws:393|0|2.75) AliApp(AP/10.5.36.8100) AlipayClient/10.5.36.8100 Language/zh-Hans Quark/10.19.0.1234`],
  ];
  for (const [名, ua] of 支持) {
    it(`${名}：不提示`, () => { expect(换浏览器提示(认浏览器(ua))).toBeNull(); });
  }
  const 不支持: [string, string][] = [
    ["小米浏览器", `${安卓} Chrome/109.0.5414.118 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.9.30710`],
    ["UC", `${安卓} Chrome/78.0.3904.108 UCBrowser/16.3.8.1293 Mobile Safari/537.36`],
    ["OPPO 浏览器", `${安卓} Chrome/90.0.4430.61 Mobile Safari/537.36 HeyTapBrowser/40.8.38.1`],
    ["vivo 浏览器", `${安卓} Chrome/87.0.4280.141 Mobile Safari/537.36 VivoBrowser/14.4.1.0`],
    ["三星浏览器", `${安卓} SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36`],
    ["认不出来（Firefox）", "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0"],
  ];
  for (const [名, ua] of 不支持) {
    it(`${名}：推荐换 Edge / Safari`, () => { expect(换浏览器提示(认浏览器(ua))).toBe(推荐浏览器的话); });
  }
  it("QQ App 里：推荐之外再教怎么跳到浏览器", () => {
    const 话 = 换浏览器提示(认浏览器(`${安卓} Chrome/109.0.0.0 Mobile Safari/537.36 V1_AND_SQ_9.0.0_4660_YYB_D QQ/9.0.0.14110 NetType/WIFI`));
    expect(话).toContain(推荐浏览器的话);
    expect(话).toContain("点右上角 ··· →「在浏览器打开」");
  });
  it("话就是定好的那句", () => {
    expect(推荐浏览器的话).toBe("扫名片请用 Edge（安卓）或 Safari（iPhone）打开，其他浏览器可能打不开相机");
  });
});
