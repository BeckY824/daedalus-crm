"use client";

import { useState } from "react";
import { App, Button, Popconfirm, Tooltip } from "antd";
import { ExperimentOutlined } from "@ant-design/icons";
import { 设测试账号 } from "../actions";
import type { 测试来由 } from "@/lib/tenant/test-accounts";

/** 列表、详情页名字后面那个标签。运营账号多一个「运营」，说明它为什么算（不是谁标的） */
export function TestAccountTag({ 测试 }: { 测试: 测试来由 | null }) {
  if (!测试) return null;
  return (
    <span className="opx-tag opx-tag-warn" style={{ marginLeft: 8 }} title="测试账号：AI 不限次数，不算进注册、活跃和用量统计">
      {测试 === "运营" ? "测试 · 运营" : 测试 === "预设" ? "测试 · 预设" : "测试"}
    </span>
  );
}

/**
 * 标成 / 取消测试账号（2026-10-04）。都要先确认一下：标错了会让一个真实用户从统计里消失、AI 也变成不限。
 * 运营账号默认就是测试账号（OPS_ACCOUNTS，见 lib/tenant/test-accounts.ts），这里取消不了——按钮灰着说清楚为什么。
 *
 * 用户列表里一整行是可点的（点进详情），所以这里把点击拦在自己这儿：确认框是挂在 body 上的，
 * 但 React 的事件照组件树冒泡，不拦的话点「确定」也会顺带跳进详情页。
 */
export function TestAccountToggle({ token, accountId, name, 测试, 小 }: { token: string; accountId: string; name: string; 测试: 测试来由 | null; 小?: boolean }) {
  const { message } = App.useApp();
  const [忙, set忙] = useState(false);

  if (测试 === "运营" || 测试 === "预设") {
    return (
      <span onClick={(e) => e.stopPropagation()}>
        <Tooltip title={测试 === "运营" ? "运营账号（OPS_ACCOUNTS 里的）默认就是测试账号；需从运营名单移除" : "注册前预设的测试账号；需从 TEST_ACCOUNTS 名单移除才能恢复普通账号"}>
          <Button size={小 ? "small" : "middle"} type={小 ? "link" : "default"} disabled icon={小 ? undefined : <ExperimentOutlined />}>
            {测试 === "运营" ? "运营账号" : "预设测试"}
          </Button>
        </Tooltip>
      </span>
    );
  }

  const 要标 = !测试;
  async function 改() {
    set忙(true);
    const r = await 设测试账号({ token, accountId, on: 要标 });
    set忙(false);
    if (r.ok) message.success(要标 ? `${name} 标成了测试账号` : `已取消 ${name} 的手工测试标记；配置名单中的账号仍按测试账号处理`);
    else message.error(r.error);
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Popconfirm
        title={要标 ? `把 ${name} 标成测试账号？` : `取消 ${name} 的测试账号？`}
        description={
          要标
            ? "AI 不限次数；不再算进注册、活跃、设备、用量这些统计，也不再为他发运营通知。随时可以取消，会留痕。"
            : "回到普通账号：AI 照常扣次数，重新算进各项统计。会留痕。"
        }
        okText={要标 ? "标成测试账号" : "取消测试"}
        cancelText="算了"
        onConfirm={改}
      >
        <Button size={小 ? "small" : "middle"} type={小 ? "link" : "default"} loading={忙} icon={小 ? undefined : <ExperimentOutlined />}>
          {要标 ? "标为测试" : "取消测试"}
        </Button>
      </Popconfirm>
    </span>
  );
}
