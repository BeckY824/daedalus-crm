"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, App, Button, Space } from "antd";
import { 确认交接, 撤回交接, 拒收交接, type 交接行 } from "./handover-actions";

/**
 * 企业版「交接中」（D10）：客户页顶上列出等我确认的交接、我发起还没被确认的。
 * 确认前这些客户还归原负责人，接手人的客户列表里没有；这里只给个数和前几位的名字，好决定接不接。
 * 没有待确认的交接 = 什么都不显示（不是企业版的页面根本不放这个组件）
 */
export default function HandoverPending({ 等我确认, 我发起的 }: { 等我确认: 交接行[]; 我发起的: 交接行[] }) {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const [忙, set忙] = useState<string | null>(null);
  if (!等我确认.length && !我发起的.length) return null;

  async function 办(h: 交接行, 做: "确认" | "拒收" | "撤回") {
    const 走 = await modal.confirm({
      title: 做 === "确认" ? `接手「${h.从}」的 ${h.客户总数} 位客户？` : `${做}这笔交接？`,
      content: 做 === "确认"
        ? "确认后这些客户和名下的联系人、沟通记录、项目、没做完的活都转到你名下。"
        : "什么都不转，数据留在原负责人名下。",
      okText: 做, cancelText: "取消", okButtonProps: { danger: 做 !== "确认" },
    });
    if (!走) return;
    set忙(h.id);
    try {
      const r = await (做 === "确认" ? 确认交接 : 做 === "拒收" ? 拒收交接 : 撤回交接)(h.id);
      if (!r.ok) message.error(r.error);
      else message.success(做 === "确认" ? `已接手 ${r.客户} 位客户` : `已${做}`);
    } catch {
      message.error("没办成，刷新再试");
    } finally {
      set忙(null);
      router.refresh();
    }
  }

  const 说 = (h: 交接行) => {
    const 名 = h.客户.length ? `：${h.客户.join("、")}${h.客户总数 > h.客户.length ? ` 等 ${h.客户总数} 位` : ""}` : "";
    const 余 = h.kind === "离职"
      ? Object.entries(h.个数).filter(([k, n]) => k !== "客户" && n > 0).map(([k, n]) => `${n} 个${k}`).join("、")
      : "";
    return `${h.kind === "离职" ? `离职成员「${h.从}」` : `「${h.从}」名下`}的 ${h.客户总数} 位客户${余 ? `（另有 ${余}）` : ""}${名}`;
  };

  return (
    <Space orientation="vertical" style={{ width: "100%", marginBottom: 12 }}>
      {等我确认.map((h) => (
        <Alert key={h.id} type="warning" showIcon
          title={`「${h.发起人}」把${说(h)}交接给你，等你确认`}
          description="确认前这些客户还在原负责人名下，你的客户列表里看不到。"
          action={<Space>
            <Button size="small" type="primary" loading={忙 === h.id} onClick={() => 办(h, "确认")}>确认接手</Button>
            <Button size="small" disabled={忙 === h.id} onClick={() => 办(h, "拒收")}>拒收</Button>
          </Space>}
        />
      ))}
      {我发起的.map((h) => (
        <Alert key={h.id} type="info" showIcon
          title={`交接中：${说(h)}，等「${h.给}」确认`}
          action={h.我能撤回 ? <Button size="small" disabled={忙 === h.id} onClick={() => 办(h, "撤回")}>撤回</Button> : undefined}
        />
      ))}
    </Space>
  );
}
