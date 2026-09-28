"use client";

import { useState } from "react";
import Link from "next/link";
import { App, Button, Segmented, Tooltip } from "antd";
import { dayjs } from "@/lib/utils";
import { 标记反馈 } from "../actions";
import { 站内, 页头, LinkPending } from "../OpsShell";
import type { 反馈条 } from "../data";

type 看 = "没处理" | "处理过了" | "全部";

/**
 * 反馈。默认只看没处理的：处理过的收起来，但不删——一条反馈是有人花时间写的，
 * 读过就收起来，不该被一个误点抹掉。原话原样显示，换行照他敲的来：
 * 改写别人的话是复现问题时最容易丢线索的一步。
 */
export default function FeedbackView({ token, 反馈 }: { token: string; 反馈: 反馈条[] }) {
  const { message } = App.useApp();
  const 没处理 = 反馈.filter((f) => !f.handled);
  const [看, set看] = useState<看>(没处理.length ? "没处理" : "全部");
  const [忙, set忙] = useState<string | null>(null);
  const 列 = 看 === "全部" ? 反馈 : 反馈.filter((f) => (看 === "没处理" ? !f.handled : f.handled));

  async function 切(f: 反馈条) {
    set忙(f.id);
    const r = await 标记反馈({ token, id: f.id, handled: !f.handled });
    set忙(null);
    if (!r.ok) message.error(r.error);
  }

  return (
    <>
      <页头
        标题="反馈"
        说明="用户在应用里点「反馈」发来的原话，附带发的时候在哪一页、什么版本"
        右={
          <Segmented<看>
            value={看}
            onChange={set看}
            options={[
              { value: "没处理", label: `没处理 ${没处理.length}` },
              { value: "处理过了", label: `处理过了 ${反馈.length - 没处理.length}` },
              { value: "全部", label: `全部 ${反馈.length}` },
            ]}
          />
        }
      />

      {列.length === 0 ? (
        <section className="opx-card">
          <div className="opx-empty">{看 === "没处理" ? "都处理过了" : "还没有反馈"}</div>
        </section>
      ) : (
        列.map((f) => (
          <div key={f.id} className={`opx-fb ${f.handled ? "opx-fb-done" : "opx-fb-todo"}`}>
            <div className="opx-fb-h">
              {f.accountId ? (
                <Link href={站内(token, `/users/${f.accountId}`)}><LinkPending />
                  <b>{f.who || "（不知道是谁）"}</b>
                </Link>
              ) : (
                <b>{f.who || "（不知道是谁）"}</b>
              )}
              <span className={`opx-tag${f.source === "desktop" ? " opx-tag-blue" : ""}`}>{f.source === "desktop" ? "桌面端" : "网页"}</span>
              <span className="opx-num">{dayjs(f.at).format("MM-DD HH:mm")}</span>
              {f.version && <span className="opx-num">v{f.version}</span>}
              {f.path && <span className="opx-mono">{f.path}</span>}
              <span style={{ flex: 1 }} />
              {/* 系统信息挺长，放进悬停：它只在「复现不出来」的时候才要看 */}
              {f.platform && (
                <Tooltip title={f.platform}>
                  <span className="opx-tag">系统</span>
                </Tooltip>
              )}
              <Button size="small" type={f.handled ? "text" : "default"} loading={忙 === f.id} onClick={() => 切(f)}>
                {f.handled ? "重新打开" : "处理过了"}
              </Button>
            </div>
            <p>{f.body}</p>
          </div>
        ))
      )}
    </>
  );
}
