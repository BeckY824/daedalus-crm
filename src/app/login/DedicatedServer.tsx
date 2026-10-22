"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Button, Alert } from "antd";
import { 桌面端设专属服务器, 桌面端退出专属服务器 } from "./actions";
import type { 专属服务器 } from "@/lib/desktop/dedicated-server";

/**
 * 登录页底下那一行「使用专属服务器」（2026-10-21，客户 Even 的团队连只给他们用的云端）。
 *
 * 平时只是一行灰字，点开才是输入框：绝大多数人用不着，别让它抢了邮箱框的位置。
 * 设了专属服务器就一直摆着「连的是哪台」和「退出专属服务器」——人得知道自己连的不是正式服，
 * 登录不上时才知道该找谁。认地址最多等 15 秒（见 dedicated-server.ts），按钮转着、说清在干什么。
 * 换好了 router.refresh()：登录页按新服务器重画（page.tsx 用服务器地址当 key，策略跟着重新问）。
 */

/** 本机联调的地址不提「没加密」 */
const 本机 = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);

function 显示(url: string) {
  try {
    const u = new URL(url);
    return { 主机: u.host + (u.pathname === "/" ? "" : u.pathname), 未加密: u.protocol === "http:" && !本机(u.host) };
  } catch {
    return { 主机: url, 未加密: false };
  }
}

export default function DedicatedServer({ 当前, 显示入口 }: { 当前: 专属服务器; 显示入口: boolean }) {
  const router = useRouter();
  const [开着, set开着] = useState(false);
  const [输入, set输入] = useState("");
  const [忙, set忙] = useState(false);
  const [错, set错] = useState<string | null>(null);

  async function 办(p: Promise<{ ok: true } | { ok: false; error: string }>) {
    set忙(true);
    set错(null);
    try {
      const r = await p;
      if (!r.ok) return set错(r.error);
      set开着(false);
      set输入("");
      router.refresh();
    } catch {
      set错("没办成，请检查网络后重试");
    } finally {
      set忙(false);
    }
  }

  const 连 = () => {
    if (忙) return;
    if (!输入.trim()) return set错("请填专属服务器的地址，或者粘贴专属服务器码");
    void 办(桌面端设专属服务器(输入));
  };
  const 退 = () => {
    if (!忙) void 办(桌面端退出专属服务器());
  };

  const 表单 = 开着 && (
    <div className="auth-server-form">
      <label className="auth-label" htmlFor="server-addr">
        专属服务器地址或专属服务器码
      </label>
      <Input
        id="server-addr"
        value={输入}
        onChange={(e) => set输入(e.target.value)}
        // 在登录表单里面：回车只连服务器，不能顺带提交了邮箱那一步
        onPressEnter={(e) => {
          e.preventDefault();
          连();
        }}
        placeholder="https://cn.example.com 或 DCRM-…"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        disabled={忙}
      />
      <div className="auth-server-actions">
        <Button type="primary" onClick={连} loading={忙}>
          {忙 ? "正在确认这个地址…" : "连接"}
        </Button>
        <Button
          onClick={() => {
            set开着(false);
            set错(null);
          }}
          disabled={忙}
        >
          取消
        </Button>
      </div>
      <p className="auth-alt">只有我们给你们单独开了服务器时才用得上。连好以后，这台电脑上的登录、同步、手机扫码和 AI 都走这台服务器。</p>
    </div>
  );

  const 错误 = 错 && <Alert type="error" showIcon title={错} className="auth-alert" />;

  if (当前.状态 === "坏了") {
    return (
      <div className="auth-server" data-state="broken">
        <Alert type="warning" showIcon title="这台电脑设过专属服务器，但设置读不出来了。重新填一次地址，或者退出专属服务器回到正式服。在那之前登录不了。" />
        {表单 || (
          <p className="auth-alt">
            <button type="button" className="auth-link" onClick={() => set开着(true)}>
              重新填地址
            </button>
            {" · "}
            <button type="button" className="auth-link" onClick={退} disabled={忙}>
              退出专属服务器
            </button>
          </p>
        )}
        {错误}
      </div>
    );
  }

  if (当前.状态 === "有") {
    const d = 显示(当前.url);
    return (
      <div className="auth-server" data-state="on">
        <p className="auth-alt">
          专属服务器：<b className="auth-server-host">{d.主机}</b>
          {当前.name && <span>（{当前.name}）</span>}
          {d.未加密 && <span className="auth-server-warn"> · 未加密</span>}
        </p>
        <p className="auth-alt">
          <button type="button" className="auth-link" onClick={退} disabled={忙}>
            {忙 ? "正在退出…" : "退出专属服务器"}
          </button>
          <span>，回到正式服</span>
        </p>
        {错误}
      </div>
    );
  }

  if (!显示入口) return null;
  return (
    <div className="auth-server" data-state="off">
      {表单 || (
        <p className="auth-alt">
          <button type="button" className="auth-link auth-server-entry" onClick={() => set开着(true)}>
            使用专属服务器
          </button>
        </p>
      )}
      {错误}
    </div>
  );
}
