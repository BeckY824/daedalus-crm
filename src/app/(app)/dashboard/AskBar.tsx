"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Card, Input, Button, Space, Alert, Typography, Spin } from "antd";
import { ArrowRightOutlined, CloseOutlined } from "@ant-design/icons";
import { askHome, quickBrief, type HomeAnswer } from "./ask";
import AskDataResult from "../reports/AskDataResult";
import BriefBody from "../customers/[id]/BriefBody";
import { useBusiness } from "@/lib/business-client";

/**
 * 首页的提问框。
 * 不是聊天窗：一问一答，答完就是一张结果卡，再问就换掉。
 * 问到某位学员出简报，问数字出数据；两个快捷键替人挑学员。
 */
export default function AskBar() {
  const b = useBusiness();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<HomeAnswer | null>(null);

  async function run(label: string, job: () => Promise<{ ok: true; answer: HomeAnswer } | { ok: false; error: string }>) {
    setLoading(label);
    setError(null);
    const res = await job();
    setLoading(null);
    if (res.ok) setAnswer(res.answer);
    else {
      setAnswer(null);
      setError(res.error);
    }
  }

  // 问候语按浏览器本地时间算。服务端渲染时给固定文案，客户端接管后再换：
  // 服务器时钟和使用者不在同一时区（或恰好跨了整点）会水合失配
  const greet = useSyncExternalStore(
    () => () => {},
    () => {
      const hour = new Date().getHours();
      return hour < 5 ? "夜深了。" : hour < 12 ? "早上好。" : hour < 18 ? "下午好。" : "晚上好。";
    },
    () => "你好。",
  );

  return (
    <Card style={{ marginBottom: 16 }} styles={{ body: { padding: "20px 24px" } }}>
      <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 12 }}>{greet}</div>
      <Input.TextArea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoSize={{ minRows: 1, maxRows: 3 }}
        maxLength={300}
        placeholder={`问一位${b.customer}（"王同学还能怎么推进"），或问一个数（"这个月谁签得最多"）`}
        onPressEnter={(e) => {
          if (e.shiftKey) return;
          e.preventDefault();
          if (q.trim()) void run("ask", () => askHome(q));
        }}
        style={{ fontSize: 15 }}
      />
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button size="small" loading={loading === "prep"} onClick={() => run("prep", () => quickBrief("prep"))}>
          ↳ 准备下次跟进
        </Button>
        <Button size="small" loading={loading === "recap"} onClick={() => run("recap", () => quickBrief("recap"))}>
          ↳ 回顾上次沟通
        </Button>
        <span style={{ flex: 1 }} />
        <Button type="primary" size="small" icon={<ArrowRightOutlined />} loading={loading === "ask"} disabled={!q.trim()} onClick={() => run("ask", () => askHome(q))}>
          问
        </Button>
      </div>

      {loading && !answer && (
        <div style={{ marginTop: 16, color: "#5a6a80" }}>
          <Spin size="small" /> <span style={{ marginLeft: 8 }}>正在通读记录…</span>
        </div>
      )}
      {error && <Alert type="warning" showIcon title={error} style={{ marginTop: 14 }} />}

      {answer && (
        <div style={{ marginTop: 16, borderTop: "1px dashed #e2e8f2", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {answer.kind === "customer" ? (
              <Space size={6}>
                <Typography.Text strong style={{ fontSize: 15 }}>
                  {answer.customerName}
                </Typography.Text>
                <Link href={`/customers/${answer.customerId}`} style={{ fontSize: 13 }}>
                  打开{b.customer}页
                </Link>
              </Space>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                问数据
              </Typography.Text>
            )}
            <span style={{ flex: 1 }} />
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setAnswer(null)} />
          </div>
          {answer.kind === "customer" ? <BriefBody brief={answer.brief} /> : <AskDataResult result={answer.result} />}
        </div>
      )}
    </Card>
  );
}
