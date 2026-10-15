"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button } from "antd";
import { MobileOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import { 已连接手机动作, 移除手机动作 } from "./team-actions";

/**
 * 设置 → 团队 → 手机（2026-10-15，手机端方案 3.2）。
 * 手机上用同一个账号登录后，这台电脑会弹出授权框（components/MobileAuthPrompt）；授权过的列在这里，丢了就移除。
 */
export default function PhonesCard() {
  const { message, modal } = App.useApp();
  const [列, set列] = useState<{ id: string; label: string; decidedAt: string | null; lastUsedAt: string | null }[] | null>(null);
  const [地址, set地址] = useState("");
  const [错, set错] = useState<string | null>(null);

  const 刷 = useCallback(() => 已连接手机动作().then((r) => {
    if (r.ok) { set列(r.手机); set地址("地址" in r ? String(r.地址) : ""); set错(null); } else set错(r.error);
  }), []);
  useEffect(() => {
    let 还在 = true;
    已连接手机动作().then((r) => {
      if (!还在) return;
      if (r.ok) { set列(r.手机); set地址("地址" in r ? String(r.地址) : ""); } else set错(r.error);
    });
    // 授权框那边点了允许，这里跟着出现
    const on = () => void 刷();
    window.addEventListener("daedalus:mobile-linked", on);
    return () => { 还在 = false; window.removeEventListener("daedalus:mobile-linked", on); };
  }, [刷]);

  function 移除(p: { id: string; label: string }) {
    modal.confirm({
      title: `移除「${p.label}」？`,
      content: "这台手机会马上退出登录、不能再同步。已经在手机上的内容请在手机浏览器里清掉网站数据。",
      okText: "移除", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => {
        const r = await 移除手机动作(p.id, p.label);
        if (r.ok) { message.success("已移除"); void 刷(); } else message.error(r.error);
      },
    });
  }

  return (
    <section className="team-card" data-testid="team-phones">
      <h3><MobileOutlined /> 手机</h3>
      <p className="muted">
        手机上随时查客户、记跟进。用手机浏览器打开{地址 ? <> <b>{地址}</b> </> : "手机版"}，用这个账号登录，再回这台电脑点「允许」。
        数据加密后经我们转交，我们看不到内容。
      </p>
      {错 && <p className="muted">{错}</p>}
      {列 && 列.length > 0 && (
        <ul className="team-members">
          {列.map((p) => (
            <li key={p.id}>
              <b>{p.label}</b>
              <span className="muted">
                {p.decidedAt ? `授权于 ${smartTime(p.decidedAt)}` : ""}
                {p.lastUsedAt ? ` · 最近使用 ${smartTime(p.lastUsedAt)}` : ""}
              </span>
              <Button size="small" type="text" danger onClick={() => 移除(p)}>移除</Button>
            </li>
          ))}
        </ul>
      )}
      {列 && 列.length === 0 && <p className="muted">还没有连手机。</p>}
    </section>
  );
}
