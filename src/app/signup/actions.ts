"use server";

import { headers } from "next/headers";
import { 需要验证码 } from "@/lib/tenant/signup-policy";
import { 发注册码, 注册账号, type SendCodeResult, type SignupResult } from "@/lib/tenant/signup";
import { 解析来源IP } from "@/lib/rate-limit";

/**
 * 注册：邮箱 + 验证码 + 密码 → **一个云端账号，给桌面端登录用**。
 *
 * **它不开工作区、也不是网页版的试用**（2026-09-16 起，细节见下面建完账号那一段）。
 * 网页版能试用的只有那个共享工作区，一套固定账号密码由我们发给要试的团队；
 * 拿注册出来的账号去登录网页版会被挡下，页面告诉他「这个账号用于桌面端」。
 * 这一节原来写的是「→ 开一个工作区，试用 7 天」，那是 2026-09-16 之前的事，
 * 而下面的代码早就不那么做了——**两处对不上时信代码**，这几行现在按代码改过来了。
 *
 * **只收邮箱。** 手机号那条路要短信通道，而国内短信签名要域名备案，服务器在境外办不下来；
 * 与其在注册页摆一个填了就被拒的入口，不如不摆。登录仍然认手机号——早先开的账号还在用。
 *
 * 也不要姓名和团队名：账号不带工作区，没有团队可命名；名字取邮箱前缀，
 * 登录桌面端之后在「个人资料」里随时能改（改过的不会被登录时的同步覆盖）。
 *
 * **一个账号一套账号密码，没有第二种凭据。** 早先注册时还认一个「激活码 / 邀请码」
 * ——一次性的、万能的各一种，填了多送 AI 次数。整套已经下线（2026-09-15 用户拍板）：
 * 它让「怎么才能开号」有了好几个说法，而这件事应该只有一个说法。
 *
 * 只在托管版可用。自部署版没有"注册"这回事——那里是管理员建账号。
 *
 * 开不开、要不要验证码、发不发得出码这三个判断在 lib/tenant/signup-policy.ts。
 * 只跳页面不拦动作是不够的：Server Action 是独立端点，绕过页面直接调得到。
 *
 * 规则本身在 lib/tenant/signup.ts，和桌面端的 /api/account/signup/* 共用一份；这里只取来源 IP。
 */

export type { SendCodeResult, SignupResult };

async function ip(): Promise<string | null> {
  return 解析来源IP((await headers()).get("x-forwarded-for"));
}

/** 发注册用的验证码。规则（包括故意直说「已经注册过了」）见 lib/tenant/signup.ts */
export async function requestCode(targetRaw: string): Promise<SendCodeResult> {
  return 发注册码(targetRaw, await ip());
}

export async function signup(input: { target: string; code?: string; password: string; name?: string; agreed?: boolean }): Promise<SignupResult> {
  return 注册账号(input, await ip());
}

/** 注册页用它决定要不要画验证码那一栏 */
export async function 注册要验证码(): Promise<boolean> {
  return 需要验证码();
}
