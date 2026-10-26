"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Space, Tag } from "antd";
import { fmtDate } from "@/lib/utils";
import { 回项目邀请 } from "./actions";

export type 邀请行 = { id: string; projectId: string; 项目: string; 负责人: string; 邀请人: string; 角色: string | null; createdAt: string };

/**
 * 企业版：别人邀我进的项目组，在项目列表顶上等我点。同意前只露项目名、组长、谁邀的、角色；
 * 同意了直接打开项目，拒绝了负责人那边显示「没接受」
 */
export default function InviteInbox({ 邀请们 }: { 邀请们: 邀请行[] }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [忙, set忙] = useState<string | null>(null);
  if (!邀请们.length) return null;
  const 回 = async (r: 邀请行, 同意: boolean) => {
    set忙(r.id);
    try {
      const x = await 回项目邀请(r.id, 同意);
      if (!x.ok) message.error(x.error ?? "没回成，请稍后再试");
      else if (同意) {
        message.success(`已加入「${r.项目}」的项目组`);
        router.push(`/projects/${r.projectId}`);
      } else {
        message.success("已拒绝");
        router.refresh();
      }
    } catch {
      message.error("没回成，请稍后再试");
    } finally {
      set忙(null);
    }
  };
  return (
    <Card title={`待我回的项目组邀请（${邀请们.length}）`} size="small" style={{ marginBottom: 16 }}>
      {邀请们.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span style={{ flex: "1 1 240px", minWidth: 0 }}>
            <b>{r.项目}</b>
            <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>组长 {r.负责人} · {r.邀请人} 邀请 · {fmtDate(r.createdAt)}</span>
            {r.角色 && <Tag style={{ marginLeft: 8 }}>{r.角色}</Tag>}
          </span>
          <Space>
            <Button type="primary" size="small" loading={忙 === r.id} disabled={!!忙} onClick={() => void 回(r, true)}>同意</Button>
            <Button size="small" disabled={!!忙} onClick={() => void 回(r, false)}>拒绝</Button>
          </Space>
        </div>
      ))}
    </Card>
  );
}
