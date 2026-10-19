"use client";
/**
 * 「我的反馈」（2026-10-19）。**为什么是一页、不是弹窗或抽屉**：写反馈那个框是「说一句就走」，留着不动；
 * 看回复、来回说几句是「待一会儿」的事——要能从系统通知、红点、轻提示直接落进某一串（/feedback?id=），
 * 要能后退，要在 1024 宽还开着 AI 栏时也摆得下一张对话。一页把这几样都给了，弹窗哪样都别扭。
 *
 * 宽的时候左右两栏：左边列表（原话第一行、时间、回没回、没看过的圆点，最近有往来的在上），右边是那一串。
 * 窄的时候（这一块不到 720 宽——1024 的窗口开着 AI 栏就是这样）一栏：先列表，点进去是对话，顶上有返回。
 * 宽窄按这一块自己的宽度量，不按窗口：左栏拖宽了、AI 栏开着，都算在里面。
 *
 * 对话里：自己的话靠右，我们的回复靠左、标「Daedalus 团队」和时间。原样保留换行，链接可点，
 * 长英文、长链接、没空格的一长串都折行，不许撑破。「接着说」发出去先显示「发送中」，没发出去能重发、字不丢。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "antd";
import { PageHead } from "@/components/ui";
import { dayjs } from "@/lib/utils";
import { 反馈事件 } from "@/components/FeedbackButton";
import { useMyFeedback, 刷新我的反馈, 标已读, 接上 } from "@/components/feedback/store";
import { 一句, 第一行, 最后一条回复, 最近, type 带未读的反馈, type 串里一条 } from "@/lib/feedback-unread";
import "./feedback.css";

const ISSUES = "https://github.com/BeckY824/daedalus-crm/issues/new";
/** 这一块比它窄就摆成一栏。左栏 300 + 对话至少 420 */
const 两栏门槛 = 720;

/** 今天的只写钟点；今年的写月日；更早的带年 */
function 时刻(iso: string): string {
  const d = dayjs(iso);
  const 今 = dayjs();
  if (d.isSame(今, "day")) return `今天 ${d.format("HH:mm")}`;
  if (d.isSame(今.subtract(1, "day"), "day")) return `昨天 ${d.format("HH:mm")}`;
  return d.isSame(今, "year") ? d.format("MM-DD HH:mm") : d.format("YYYY-MM-DD HH:mm");
}

/**
 * 正文里的链接做成能点的。只认 http(s)：别的协议（file:、javascript:）原样当字。
 * 句末的标点不算进链接（「看这里 https://x.com/a。」那个句号不是地址的一部分）
 */
const 链接 = /https?:\/\/[^\s<>"'「」（）【】，。；！？、]+/g;
function 带链接(s: string): React.ReactNode[] {
  const 出: React.ReactNode[] = [];
  let 起 = 0;
  for (const m of s.matchAll(链接)) {
    let url = m[0];
    const 尾 = /[).,;:!?\]}>]+$/.exec(url);
    if (尾) url = url.slice(0, -尾[0].length);
    const i = m.index ?? 0;
    if (i > 起) 出.push(s.slice(起, i));
    出.push(
      <a key={i} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    起 = i + url.length;
  }
  if (起 < s.length) 出.push(s.slice(起));
  return 出;
}

type 待发 = { key: string; body: string; 态: "发送中" | "失败"; 错?: string };

export default function MyFeedbackView({ 去向 }: { 去向: "cloud" | "github" }) {
  const s = useMyFeedback(去向 === "cloud");
  const router = useRouter();
  const 选中 = useSearchParams().get("id");
  const 盒 = useRef<HTMLDivElement>(null);
  /** null = 还没量（第一帧）。没量之前不标已读：窄的时候对话根本没摆出来 */
  const [窄, set窄] = useState<boolean | null>(null);
  /** 没发出去的「接着说」按反馈存在这一层：切去别的一串再回来，字还在 */
  const [待们, set待们] = useState<Record<string, 待发[]>>({});

  // 打开这一页：不用一分钟内的那份，直接问云端最新的
  useEffect(() => {
    if (去向 === "cloud") void 刷新我的反馈({ 新: true });
  }, [去向]);

  useLayoutEffect(() => {
    const el = 盒.current;
    if (!el) return;
    const 量 = () => set窄(el.getBoundingClientRect().width < 两栏门槛);
    量();
    const ro = new ResizeObserver(量);
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.载好, s.反馈.length > 0]);

  const 显示的 = s.反馈.find((f) => f.id === 选中) ?? (窄 === false ? (s.反馈[0] ?? null) : null);

  // 摆出来、人看得见，才算看过了
  useEffect(() => {
    if (!显示的?.未读 || 窄 === null) return;
    if (document.visibilityState === "visible") 标已读(显示的);
  }, [显示的, 窄]);

  const 去 = (id: string | null) => router.replace(id ? `/feedback?id=${encodeURIComponent(id)}` : "/feedback", { scroll: false });
  const 写反馈 = () => window.dispatchEvent(new Event(反馈事件));

  if (去向 === "github") {
    return (
      <>
        <PageHead title="我的反馈" subtitle="自部署版的反馈不经过我们的服务器" />
        <div className="mfb-empty card-soft">
          <p>这个部署不往外发反馈。有问题请到 GitHub 提 issue，回复也在那边。</p>
          <Button href={ISSUES} target="_blank" rel="noopener noreferrer">
            去 GitHub 提 issue
          </Button>
        </div>
      </>
    );
  }

  const 有 = s.反馈.length > 0;
  return (
    <>
      <PageHead
        title="我的反馈"
        subtitle="你发给我们的反馈，和我们的回复"
        extra={
          有 ? (
            <Button type="primary" onClick={写反馈}>
              写反馈
            </Button>
          ) : undefined
        }
      />
      {!s.载好 ? (
        <div className="mfb-empty card-soft" aria-busy="true">
          <p className="mfb-muted">正在取你的反馈…</p>
        </div>
      ) : !有 ? (
        <div className="mfb-empty card-soft">
          <p>
            {s.出错
              ? "暂时连不上我们的服务器，你发过的反馈和回复等连上了会出现在这里。"
              : "你还没发过反馈。用着哪儿别扭、哪儿出错了，写一句给我们——回复会出现在这里。"}
          </p>
          <Button type="primary" onClick={写反馈}>
            写反馈
          </Button>
        </div>
      ) : (
        <div ref={盒} className={`mfb${窄 ? " is-narrow" : ""}${显示的 ? " has-sel" : ""}`} data-testid="my-feedback">
          <ul className="mfb-list" aria-label="我发过的反馈">
            {s.反馈.map((f) => (
              <ListItem key={f.id} f={f} 选中={显示的?.id === f.id} 点={() => 去(f.id)} />
            ))}
          </ul>
          {显示的 ? (
            <Thread
              key={显示的.id}
              f={显示的}
              窄={窄 === true}
              返回={() => 去(null)}
              待={待们[显示的.id] ?? []}
              set待={(fn) => set待们((m) => ({ ...m, [显示的.id]: fn(m[显示的.id] ?? []) }))}
            />
          ) : (
            !窄 && <div className="mfb-thread mfb-thread-none" />
          )}
        </div>
      )}
    </>
  );
}

function ListItem({ f, 选中, 点 }: { f: 带未读的反馈; 选中: boolean; 点: () => void }) {
  const 回 = 最后一条回复(f);
  return (
    <li>
      <button type="button" className={`mfb-item${选中 ? " on" : ""}`} onClick={点} aria-current={选中 ? "true" : undefined}>
        <span className="mfb-item-t" dir="auto">
          {第一行(f.body) || "（空）"}
        </span>
        <span className="mfb-item-m">
          <span>{时刻(最近(f))}</span>
          <span className={回 ? "mfb-tag on" : "mfb-tag"}>{回 ? "已回复" : "等回复"}</span>
          {f.未读 && <span className="mfb-dot" aria-label="有没看过的回复" />}
        </span>
        {回 && (
          <span className="mfb-item-r" dir="auto">
            {一句(回.body, 60)}
          </span>
        )}
      </button>
    </li>
  );
}

function Bubble({ 谁, at, body, 尾 }: { 谁: "我" | "团队"; at: string | null; body: string; 尾?: React.ReactNode }) {
  return (
    <div className={`mfb-msg ${谁 === "我" ? "me" : "team"}`}>
      <div className="mfb-msg-h">
        {谁 === "团队" ? <b>Daedalus 团队</b> : <b>我</b>}
        {at && <span>{时刻(at)}</span>}
      </div>
      <div className="mfb-bubble" dir="auto">
        {带链接(body)}
      </div>
      {尾}
    </div>
  );
}

function Thread({
  f,
  窄,
  返回,
  待,
  set待,
}: {
  f: 带未读的反馈;
  窄: boolean;
  返回: () => void;
  待: 待发[];
  set待: (fn: (xs: 待发[]) => 待发[]) => void;
}) {
  const [字, set字] = useState("");
  const 滚 = useRef<HTMLDivElement>(null);
  const 有回复 = f.消息.some((m) => m.谁 === "团队");
  const 条数 = f.消息.length + 待.length;

  // 新的一条（发出去的、刚收到的）落在底下：滚到底
  useEffect(() => {
    const el = 滚.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [条数]);

  async function 发(p: 待发) {
    set待((xs) => [...xs.filter((x) => x.key !== p.key), { ...p, 态: "发送中", 错: undefined }]);
    try {
      const r = await fetch("/api/feedback/mine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackId: f.id, body: p.body, clientKey: p.key }),
      });
      const j = (await r.json().catch(() => ({}))) as { 消息?: 串里一条; error?: string };
      if (!r.ok || !j.消息) throw new Error(j.error || "没发出去");
      接上(f.id, j.消息);
      set待((xs) => xs.filter((x) => x.key !== p.key));
    } catch (e) {
      set待((xs) => xs.map((x) => (x.key === p.key ? { ...x, 态: "失败", 错: e instanceof Error ? e.message : "没发出去" } : x)));
    }
  }

  function 送() {
    const body = 字.trim();
    if (!body) return;
    set字("");
    void 发({ key: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, body, 态: "发送中" });
  }

  return (
    <section className="mfb-thread" aria-label="对话">
      <header className="mfb-th">
        {窄 && (
          <button type="button" className="mfb-back" onClick={返回}>
            ‹ 全部反馈
          </button>
        )}
        <div className="mfb-th-t">
          <b dir="auto">{第一行(f.body) || "（空）"}</b>
          <span>{`发于 ${时刻(f.at)}`}</span>
        </div>
      </header>
      <div className="mfb-msgs" ref={滚}>
        <Bubble 谁="我" at={f.at} body={f.body} />
        {f.消息.map((m) => (
          <Bubble key={m.id} 谁={m.谁} at={m.at} body={m.body} />
        ))}
        {!有回复 && <p className="mfb-wait">我们看到了，回复会出现在这里</p>}
        {待.map((p) => (
          <Bubble
            key={p.key}
            谁="我"
            at={null}
            body={p.body}
            尾={
              p.态 === "发送中" ? (
                <div className="mfb-st">发送中…</div>
              ) : (
                <div className="mfb-st bad" role="alert">
                  没发出去{p.错 ? `：${p.错}` : ""}
                  <button type="button" onClick={() => void 发(p)}>
                    重发
                  </button>
                </div>
              )
            }
          />
        ))}
      </div>
      <div className="mfb-compose">
        <Input.TextArea
          value={字}
          onChange={(e) => set字(e.target.value)}
          placeholder="接着说…"
          aria-label="接着说"
          autoSize={{ minRows: 1, maxRows: 6 }}
          maxLength={4000}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              送();
            }
          }}
        />
        <Button type="primary" disabled={!字.trim()} onClick={送}>
          发送
        </Button>
      </div>
    </section>
  );
}
