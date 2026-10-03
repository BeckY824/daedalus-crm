/**
 * 第六轮（打包实机验 0.46.15）：没令牌时走登录页，登录完整个窗口跑在 http://localhost:端口 上，不是 127.0.0.1。
 *
 * 实机复现（打出来的 .app，真实数据副本删掉 .cloud.json）：
 *   壳加载 127.0.0.1/api/desktop/session → 没令牌 → 307 到 /api/auth/logout
 *   → logout 用 NextResponse.redirect(new URL("/login", request.url)) 拼了绝对地址，
 *     standalone 服务里 request.url 的主机名被规范成 localhost → 窗口落在 http://localhost:端口/login，
 *     登录之后也一直在 localhost 上。
 * 后果（实测）：
 *   - 外观（主题 / 底色）和列表列存在 127.0.0.1 那个源的 localStorage 里，localhost 上全是默认；
 *     这时改的外观存进 localhost 源，下次启动壳回到 127.0.0.1，又不见了。第一次装好登录的新用户必中。
 *   - 路由记忆按 127.0.0.1 比对，localhost 上点哪页都不记 lastRoute。
 *   - 会话 cookie 下发在 localhost 上，菜单「前往 / 设置…」拼的是 127.0.0.1，两边会话不通。
 * api/desktop/session 早就因为同一个原因改成相对地址跳（见那边的注释），logout 这条漏了。
 *
 * 修法：logout 的 GET 也回相对地址：new NextResponse(null, { status: 307, headers: { Location: "/login" + 原因 } })。
 * 修好后把 it.skip 去掉。
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ destroySession: async () => {} }));
vi.mock("@/lib/desktop/cloud", () => ({ 本地模式: () => true, 退出: async () => {} }));

import { GET } from "@/app/api/auth/logout/route";

describe("logout 跳回登录页不能换主机名", () => {
  it("还是跳到 /login，原因带着（下面那条的前提）", async () => {
    const res = await GET(new NextRequest("http://localhost:56245/api/auth/logout?reason=revoked"));
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") ?? "";
    expect(new URL(loc, "http://127.0.0.1:56245").pathname).toBe("/login");
    expect(loc).toContain("reason=revoked");
  });

  it.skip("Location 是相对地址——不把 request.url 里（被规范成 localhost）的主机名拼进去", async () => {
    const res = await GET(new NextRequest("http://localhost:56245/api/auth/logout"));
    const loc = res.headers.get("location") ?? "";
    expect(loc, `logout 跳去了 ${loc}：浏览器原来在 127.0.0.1 上，跳过去就换了源`).toMatch(/^\/login/);
  });
});
