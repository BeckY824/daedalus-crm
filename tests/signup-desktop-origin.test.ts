/**
 * 桌面端登录窗里点「注册新账号」开浏览器到 /signup?from=desktop。
 * 注册完这个人要回桌面端登录，页面不能把他丢进网页版——钉的是这个来源标记真的传到了表单。
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ReactElement } from "react";

afterEach(() => {
  delete process.env.SIGNUP_REDIRECT;
});

describe("/signup?from=desktop", () => {
  it("带来源标记时表单知道自己来自桌面端；不带时不知道", async () => {
    const { default: SignupPage } = await import("@/app/signup/page");
    const 桌面 = (await SignupPage({ searchParams: Promise.resolve({ from: "desktop" }) })) as ReactElement<{ 来自桌面端: boolean }>;
    expect(桌面.props.来自桌面端).toBe(true);
    const 网页 = (await SignupPage({ searchParams: Promise.resolve({}) })) as ReactElement<{ 来自桌面端: boolean }>;
    expect(网页.props.来自桌面端).toBe(false);
    const 乱填 = (await SignupPage({ searchParams: Promise.resolve({ from: "evil" }) })) as ReactElement<{ 来自桌面端: boolean }>;
    expect(乱填.props.来自桌面端).toBe(false);
  });
});
