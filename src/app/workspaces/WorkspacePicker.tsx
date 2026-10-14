"use client";

import { useState } from "react";
import { 切换工作区 } from "./actions";

type Workspace = { id: string; name: string; role: string; writable: boolean };
export default function WorkspacePicker({ list, current }: { list: Workspace[]; current: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function choose(id: string) {
    if (busy) return;
    setBusy(id); setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        切换工作区(id),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 20_000); }),
      ]);
      if (!r.ok) { setError(r.error); setBusy(null); return; }
      // 会话换库必须整页重载，清除旧工作区的AI任务、对话和页面内存。
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/start");
    } catch {
      setError("切换请求失败，请检查网络后重试"); setBusy(null);
    } finally {
      clearTimeout(timer);
    }
  }
  return <div className="auth-form">
    <h1>选择工作区</h1>
    <p className="auth-hint">进入后可从账号菜单切换。切换前请先保存当前页面的修改。</p>
    {error && <p role="alert">{error}</p>}
    <div style={{ display: "grid", gap: 12 }}>
      {list.map(w => <button key={w.id} type="button" disabled={busy !== null} onClick={() => void choose(w.id)}
        style={{ textAlign: "left", padding: 16, borderRadius: 12, border: "1px solid var(--line-soft)", background: "var(--page-bg)", color: "inherit", cursor: "pointer" }}>
        <strong>{w.name}</strong>{w.id === current && <span> · 当前</span>}
        <div>{w.role === "OWNER" ? "所有者" : "成员"} · {w.writable ? "可编辑" : "只读"}{busy === w.id ? " · 正在进入…" : ""}</div>
      </button>)}
    </div>
  </div>;
}
