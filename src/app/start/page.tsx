import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { 要选模版 } from "@/lib/onboarding";
import AuthSide from "../login/AuthSide";
import TemplatePicker from "./TemplatePicker";

/**
 * 新用户第一次进来先选模版。不该选（老用户、网页版、选过了）就直接去首页。
 *
 * **放在主界面外面，和登录页一个样子**（2026-10-03 用户：「应该是登录完的界面还未切到主界面的时候进行选择」）：
 * 原来在 (app) 里，左边导航、AI 次数都摆出来了，像是已经进来了又被拦住；
 * 而且是先进首页、首页再跳过来，主界面会闪一下。现在登录 / 注册成功、桌面端自动登录都先落到这里，
 * 这一页在 (app) 外面、没有流式外壳，不该选时的 redirect 是一个干净的 307。
 */
export const dynamic = "force-dynamic";

export default async function StartPage() {
  await requireUser();
  if (!(await 要选模版())) redirect("/dashboard");
  return (
    <div className="auth">
      <AuthSide />
      <main className="auth-main">
        <TemplatePicker />
      </main>
    </div>
  );
}
