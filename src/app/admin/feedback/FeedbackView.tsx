"use client";

import Shortcut from "@/components/Shortcut";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { App, Button, Checkbox, Input, Segmented, Tooltip } from "antd";
import { dayjs } from "@/lib/utils";
import { 标记反馈, 回复反馈 } from "../actions";
import { 站内, 页头, LinkPending } from "../OpsShell";
import type { 反馈条 } from "../data";

type 看 = "没处理" | "处理过了" | "全部";

/**
 * 反馈。默认只看没处理的：处理过的收起来，但不删——一条反馈是有人花时间写的，
 * 读过就收起来，不该被一个误点抹掉。原话原样显示，换行照他敲的来：
 * 改写别人的话是复现问题时最容易丢线索的一步。
 *
 * 「回复」就地展开一个小框。**回复默认进对方的桌面端应用**（2026-10-19）：红点、系统通知、「我的反馈」里看得到；
 * 对方有邮箱的话可以勾「同时发邮件」。对方在应用里「接着说」的也挂在这条下面——原话下面就是一整串，
 * 免得两个人回同一条、或者忘了答应过什么。网页版的老反馈进不了应用，只能填邮箱发邮件（原来那样）。
 */
export default function FeedbackView({ token, 反馈, 回信到, 能发邮件 }: { token: string; 反馈: 反馈条[]; 回信到: string; 能发邮件: boolean }) {
  const { message } = App.useApp();
  const 没处理 = 反馈.filter((f) => !f.handled);
  const [看, set看] = useState<看>(没处理.length ? "没处理" : "全部");
  const [忙, set忙] = useState<string | null>(null);
  // 正在写回复的那一条。草稿按条存着：收起再打开，写了一半的还在
  const [写, set写] = useState<string | null>(null);
  const [草稿, set草稿] = useState<Record<string, 草稿>>({});
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
              {/* 有地址时地址自己占满中间、放不下就省略号；没有才要空白把按钮推到右边。
                  原来空白 + 长地址一起抢，挤不下时「系统 / 回复 / 处理过了」掉到第二行左边，每条位置都不一样（10-19 排查） */}
              {!f.path && <span style={{ flex: 1 }} />}
              {/* 系统信息挺长，放进悬停：它只在「复现不出来」的时候才要看 */}
              {f.platform && (
                <Tooltip title={f.platform}>
                  <span className="opx-tag">系统</span>
                </Tooltip>
              )}
              <Button size="small" type={写 === f.id ? "primary" : "default"} ghost={写 === f.id} onClick={() => set写(写 === f.id ? null : f.id)}>
                回复
              </Button>
              <Button size="small" type={f.handled ? "text" : "default"} loading={忙 === f.id} onClick={() => 切(f)}>
                {f.handled ? "重新打开" : "处理过了"}
              </Button>
            </div>
            <p>{f.body}</p>
            {f.串.length > 0 && (
              <div className="opx-fb-thread" aria-label="往来">
                {f.串.map((m) =>
                  m.谁 === "团队" ? (
                    <div key={m.id} className="opx-fb-reply">
                      <div className="opx-fb-reply-h">
                        我们回复 <span className="opx-num">{dayjs(m.at).format("MM-DD HH:mm")}</span>
                        {m.by && m.by !== "口令" && <span> · {m.by}</span>}
                        <span> · </span>
                        {m.邮件 ? (
                          m.邮件.ok ? (
                            <span>{f.accountId ? "应用里 + 邮件" : "邮件"} → {m.邮件.to}</span>
                          ) : (
                            <span className="opx-fb-mail-bad">应用里已送到，邮件没发出去（{m.邮件.to}）</span>
                          )
                        ) : (
                          <span>只在应用里</span>
                        )}
                      </div>
                      <p>{m.body}</p>
                    </div>
                  ) : (
                    <div key={m.id} className="opx-fb-reply opx-fb-user">
                      <div className="opx-fb-reply-h">
                        对方接着说 <span className="opx-num">{dayjs(m.at).format("MM-DD HH:mm")}</span>
                      </div>
                      <p>{m.body}</p>
                    </div>
                  ),
                )}
              </div>
            )}
            {写 === f.id && (
              <ReplyBox
                token={token}
                f={f}
                回信到={回信到}
                能发邮件={能发邮件}
                草稿={草稿[f.id] ?? { to: f.accountId ? "" : (f.邮箱 ?? ""), body: "", 发邮件: false }}
                改草稿={(d) => set草稿((m) => ({ ...m, [f.id]: d }))}
                收起={() => set写(null)}
                发完={(说) => {
                  set草稿((m) => {
                    const { [f.id]: _, ...rest } = m;
                    return rest;
                  });
                  set写(null);
                  if (说.警告) message.warning(说.话, 6);
                  else message.success(看 === "没处理" ? `${说.话}，这条收进「处理过了」` : 说.话);
                }}
              />
            )}
          </div>
        ))
      )}
    </>
  );
}

type 草稿 = { to: string; body: string; 发邮件: boolean };

function ReplyBox({
  token,
  f,
  回信到,
  能发邮件,
  草稿,
  改草稿,
  收起,
  发完,
}: {
  token: string;
  f: 反馈条;
  回信到: string;
  能发邮件: boolean;
  草稿: 草稿;
  改草稿: (d: 草稿) => void;
  收起: () => void;
  发完: (说: { 话: string; 警告: boolean }) => void;
}) {
  const [发, set发] = useState(false);
  const [错, set错] = useState<string | null>(null);
  const 正文框 = useRef<HTMLTextAreaElement>(null);
  const 邮箱框 = useRef<HTMLInputElement>(null);
  /** 桌面端账号：回复进应用，邮件是勾了才发的。网页版的老反馈只能发邮件 */
  const 进应用 = Boolean(f.accountId);
  const 邮件不能 = !f.邮箱 ? "这个账号是手机号注册的，没留邮箱：只能在应用里看到" : !能发邮件 ? "邮件通道没配好（SMTP），这次只发到应用里" : null;

  // 打开就能打字：要填邮箱的先落邮箱
  useEffect(() => {
    (进应用 || 草稿.to ? 正文框.current : 邮箱框.current)?.focus();
    // 只在打开那一下
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function 送() {
    if (发) return;
    set错(null);
    set发(true);
    const r = await 回复反馈({ token, id: f.id, body: 草稿.body, ...(进应用 ? { 发邮件: 草稿.发邮件 && !邮件不能 } : { to: 草稿.to }) });
    set发(false);
    if (!r.ok) {
      set错(r.error);
      return;
    }
    if (!进应用) 发完({ 话: `已发邮件到 ${r.邮件到}`, 警告: false });
    else if (r.邮件 === "发了") 发完({ 话: `已发到对方应用里，邮件也发到了 ${r.邮件到}`, 警告: false });
    else if (r.邮件 === "没发出去") 发完({ 话: `已发到对方应用里；邮件没发出去${r.原因 ? `（${r.原因}）` : ""}`, 警告: true });
    else 发完({ 话: "已发到对方应用里", 警告: false });
  }

  return (
    <div
      className="opx-fb-compose"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          收起();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void 送();
        }
      }}
    >
      {!进应用 && (
        <div className="opx-fb-compose-to">
          <span>发到</span>
          <Input
            ref={(el) => {
              邮箱框.current = el?.input ?? null;
            }}
            size="small"
            value={草稿.to}
            placeholder="网页版的反馈进不了应用，填一个邮箱"
            aria-label="收件邮箱"
            onChange={(e) => 改草稿({ ...草稿, to: e.target.value })}
          />
        </div>
      )}
      <Input.TextArea
        ref={(el) => {
          正文框.current = el?.resizableTextArea?.textArea ?? null;
        }}
        value={草稿.body}
        autoSize={{ minRows: 3, maxRows: 12 }}
        maxLength={4000}
        placeholder={进应用 ? "写给对方的话。会出现在对方桌面端的「我的反馈」里，原话在上面" : "写给对方的话。信里会附上原话"}
        aria-label="回复内容"
        onChange={(e) => 改草稿({ ...草稿, body: e.target.value })}
      />
      {错 && (
        <div className="opx-fb-compose-err" role="alert">
          {错}
        </div>
      )}
      <div className="opx-fb-compose-f">
        {进应用 ? (
          <span className="opx-fb-compose-mail">
            <Checkbox checked={草稿.发邮件 && !邮件不能} disabled={Boolean(邮件不能)} onChange={(e) => 改草稿({ ...草稿, 发邮件: e.target.checked })}>
              同时发邮件{f.邮箱 ? <span className="opx-mono"> {f.邮箱}</span> : null}
            </Checkbox>
            {邮件不能 && <span className="opx-fb-compose-why">{邮件不能}</span>}
          </span>
        ) : null}
        <span className="opx-fb-compose-hint">
          {进应用 ? null : <>对方回信到 {回信到} · </>}
          <Shortcut>⌘↩</Shortcut> 发送 · Esc 收起（草稿留着）
        </span>
        <Button size="small" onClick={收起}>
          取消
        </Button>
        <Button size="small" type="primary" loading={发} disabled={(!进应用 && !草稿.to.trim()) || !草稿.body.trim()} onClick={() => void 送()}>
          {进应用 ? "发送" : "发送邮件"}
        </Button>
      </div>
    </div>
  );
}
