"use client";

import type { LoginResult } from "./actions";

/** 跳转发起后仍停在本页的等待上限，超过就说明会话没真正建立。 */
const 跳转超时毫秒 = 15000;

/**
 * 登录（或在应用里注册完）成功之后怎么进去。登录表单和桌面端的新登录页共用这一段——
 * 换账号要等壳换目录那一套规矩很细，抄两份迟早改漏一边。
 *
 * 报错就回一句话（调用方显示出来、停止转圈）；回 null 表示已经在跳了，保持转圈别闪。
 */
export async function 登录之后(res: Extract<LoginResult, { ok: true }>, 报错: (msg: string) => void): Promise<void> {
  /*
    换了个云端账号登录：数据目录要跟着换（一个账号一份，见 desktop/accounts.js），
    而 DATABASE_URL 和 CRM_DATA_DIR 都是本地服务启动时读死的，非重起不可。
    所以这里**一步都不许往前走**——这会儿的 /dashboard 还是上一个人的库。

    原来这一段是「壳不在就退回硬跳转，至少不卡在这一屏」。那是 2026-09-20 那个
    bug 的正身：桥不在时（浏览器里打开的、桥没挂上）这一声没人接，页面落到
    /dashboard，而 /login 见还有令牌又自动登录回来，于是乙一路进了甲的库，
    一声不响。卡在这一屏都比那个好，所以现在宁可把话说清，让人自己重开应用。

    壳在就交给它：换目录、重起服务、把窗口重新载到新库的入口上。它的回话要等——
    从前这里是 void，换不了目录也没人知道（服务端已经拒绝往上一个人的库里写，
    人会停在一个既没进去也没报错的屏上）。
  */
  if (res.换账号) {
    const 壳 = typeof window !== "undefined" ? window.desktopShell : undefined;
    if (!壳?.switchAccount) {
      报错("已经换成这个账号了，但数据目录要跟着账号换、重起才生效。请退出应用再打开一次——两个账号的数据都在，一份都不会丢。");
      return;
    }
    const r = await 壳.switchAccount().catch(() => ({ ok: false, error: "换不了数据目录" }));
    // 成了的话壳会把窗口重载到新库的入口，这一屏就此作废——保持转圈，不要闪一下
    if (!r?.ok) 报错(`${r?.error ?? "换不了数据目录"}。请退出应用再打开一次。`);
    return;
  }

  /**
   * 用整页跳转，不用 router.push。
   * 软导航只拉 RSC 数据，会话 cookie 万一没生效（HTTP 下的 secure cookie、
   * 客户端拒收等），proxy.ts 会把请求弹回 /login——但当前组件不会重新挂载，
   * loading 永远停在 true，同样表现为无限转圈且零报错。
   * 整页跳转让浏览器重新走一遍完整请求，成败都看得见。
   * 这正是 @next/next/no-location-assign-relative-destination 要拦的写法，
   * 但登录是会话状态的变更点，此处硬跳转是有意的，故就地豁免。
   */
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  // 先到选模版那一页：新用户在进主界面之前选；不该选的它当场 307 去首页（app/start/page.tsx）
  window.location.assign("/start");

  // 跳转没能真正离开本页时的兜底提示（页面一旦卸载，这个定时器随之消失）
  setTimeout(() => 报错("登录成功但页面未能跳转，请刷新重试；若反复出现请联系管理员"), 跳转超时毫秒);
}
