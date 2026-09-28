"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { App, Tooltip } from "antd";
import { CopyOutlined, ReloadOutlined, CloseOutlined, RightOutlined } from "@ant-design/icons";
import ProposalCard from "@/components/ProposalCard";
import Markdown from "@/components/Markdown";
import { useBusiness } from "@/lib/business-client";
import { clearJob, useJob } from "@/lib/ai-jobs";
import type { StreamJob } from "@/lib/ai-stream";
import type { Turn } from "@/lib/home-thread";
import type { AgentAnswer } from "@/lib/thread-history";
import type { 提到的客户 } from "@/lib/agent/run";
import { 认死胡同 } from "@/lib/ask-dead-end";
import type { StepEvent } from "@/lib/ai-steps";
import { summarizeSteps } from "@/lib/agent/step-summary";
import { dayjs } from "@/lib/utils";
import { 起草, 草稿键, useCopyDraft, type 草稿类 } from "@/lib/draft-jobs";

/** 对话里的一轮：问题、过程条、回答、建议卡、提到的客户。首页和右侧 AI 面板共用 */

function whenLabel(at: number): string {
  const d = dayjs(at);
  const m = dayjs().diff(d, "minute");
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  return d.isToday() ? d.format("HH:mm") : d.format("MM-DD HH:mm");
}

/**
 * 自动滚动的两条规矩。
 *
 * 之前的写法是 turn.scrollIntoView({ block: "end" })，把轮次底边对齐到**视口**底边。
 * 但输入框是 position:sticky bottom:0、实测 104px 高，正好盖住视口最底下那一条——
 * 于是每次发送，刚发出的问题（top 404）就落在输入框（top 396）后面，
 * 正在生成的回答也永远差最后一百多像素露不出来。页面还会停在离真正底部 130px 的地方。
 *
 * 所以：
 *   1. 所有滚动目标都留出输入框的高度（--cli-composer-h，由 ResizeObserver 实时量）
 *   2. 只在用户已经贴着底部时才跟随。答案还在流的时候人往上翻是常事，
 *      不判断就会把他一次次拽回来
 */
function composerH(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--cli-composer-h");
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 104;
}

/**
 * 这一屏在**哪个容器里**滚。
 *
 * 宽模式（首页）：聊天就是整页，容器是文档，返回 null。
 * 窄模式（右侧面板）：容器是 `.dock-body`——**必须认出它来**，否则
 * `scrollIntoView` 会把祖先链上每一个滚动容器都滚一遍，文档也在那条链上，
 * 于是在功能页问一句，左边那一整栏跟着往下跑了 588px
 * （2026-09-19 实测：发送前 scrollTop=0，发送后 588.5）。
 * 对话是对话，正文不该动。
 */
function 滚动容器(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>(".dock-body") ?? null;
}

/**
 * 还在不在「跟着答案往下看」的状态。
 *
 * **不能靠位置推断。** 原来的判据是「离底部够近就跟」，在整页滚动下成立
 * （页面一路跟着答案走，自然一直贴着底）。但在面板那个容器里不成立：
 * 只要有一次没跟上，容器就永远显得「离底部很远」，从此再也不跟——
 * 答案在看不见的地方一路生成完（2026-09-19 改容器滚动时当场踩到）。
 *
 * 所以改成显式的：**开始一轮就跟，人自己滚一下就停。**
 * 人往上翻是想看前面的东西，那时再把他拽回来才是真的烦。
 */
function 贴着底部(容器: HTMLElement | null): boolean {
  const 余量 = composerH() + 90;
  if (容器) return 容器.scrollHeight - 容器.scrollTop - 容器.clientHeight < 余量;
  return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 余量;
}

/** 把这一轮滚到容器顶部 / 底部。容器为 null 时才退回 scrollIntoView（那时滚的就是文档） */
function 滚到(el: HTMLElement | null, 位置: "start" | "end") {
  if (!el) return;
  const 容器 = 滚动容器(el);
  if (!容器) {
    el.scrollIntoView({ behavior: "smooth", block: 位置 });
    return;
  }
  if (位置 === "end") {
    容器.scrollTo({ top: 容器.scrollHeight, behavior: "smooth" });
    return;
  }
  const 相对 = el.getBoundingClientRect().top - 容器.getBoundingClientRect().top + 容器.scrollTop;
  容器.scrollTo({ top: Math.max(0, 相对), behavior: "smooth" });
}

export default function TurnView({ turn, onRetry, onRemove, onAsk, scrollOnMount }: { turn: Turn; onRetry: () => void; onRemove: () => void; onAsk: (q: string) => void; scrollOnMount: boolean }) {
  const b = useBusiness();
  const { message } = App.useApp();
  const job = useJob<StreamJob<AgentAnswer>>(`home:${turn.id}`);
  const ref = useRef<HTMLDivElement>(null);
  const done = job?.status === "done" || job?.status === "error";
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (done || !job) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - job.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [done, job]);
  // 刚发出的这一问：把问题滚到视口顶部，答案往下面的空白里生成。
  // 不能用 block:"end"——那会把它顶到输入框后面，人看不见自己刚发的话。
  useEffect(() => {
    if (!scrollOnMount) return;
    滚到(ref.current, "start");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    流式跟随。整页滚动（首页）时沿用老判据「离底部够近就跟」；
    面板那个容器里改用显式开关——见 贴着底部 上面那段：
    位置推断在容器里会一次失手就永久失效。
  */
  const 跟随中 = useRef(true);
  useEffect(() => {
    const 容器 = 滚动容器(ref.current);
    if (!容器) return;
    // 人自己滚一下就停下跟随；滚回底部再继续
    const on = () => {
      跟随中.current = 容器.scrollHeight - 容器.scrollTop - 容器.clientHeight < composerH() + 90;
    };
    容器.addEventListener("wheel", on, { passive: true });
    容器.addEventListener("touchmove", on, { passive: true });
    return () => {
      容器.removeEventListener("wheel", on);
      容器.removeEventListener("touchmove", on);
    };
  }, []);
  useEffect(() => {
    const 容器 = 滚动容器(ref.current);
    if (容器 ? !跟随中.current : !贴着底部(null)) return;
    滚到(ref.current, "end");
  }, [job?.value?.text?.length, done]);

  const interrupted = job?.status === "error" && job.error === "已取消";
  /*
    问题还在、回答的任务没了。0.39.0 上这是**点一下侧栏「AI 任务」**的后果
    （那时点的是 clearJob，把任务连答案一起删了），屏上就剩一个光秃秃的问题气泡，
    没有任何解释、也没有出路。0.39.1 起那条路没了（收起任务只摘标签），
    其余每一处 clearJob 都紧跟着把这一轮也去掉或重跑，所以这个状态不该再出现。
    留这一行是兜底：万一哪天又漏出来，人看见的是一句话和一个「再问一次」，
    而不是一个死胡同。排队中的那一轮不算——它本来就还没开跑。
  */
  const 答案没了 = !job && !turn.queued;
  const steps: StepEvent[] = (job?.value?.steps ?? [])
    .filter((s) => s.id !== "answer")
    .map((s) => (job?.status === "error" && s.status === "running" ? { ...s, status: interrupted ? ("done" as const) : ("error" as const), detail: interrupted ? "被打断" : s.detail } : s));
  const text = job?.value?.text ?? job?.value?.answer?.text ?? "";
  /** 真的调用过几个工具。0 = 它一条数据都没查就答了 */
  const 查过几次工具 = (job?.value?.steps ?? []).filter((x) => x.id !== "answer" && x.status === "done").length;
  const 死胡同 = 认死胡同(text, turn.question, 查过几次工具);
  const answer = job?.status === "done" ? job.value?.answer : undefined;
  const writing = job?.value?.steps?.some((s) => s.id === "answer" && s.status === "running");
  const thinking = Boolean(job) && !done && !text;
  const ms = job?.value?.ms;
  const showRows = !done || open;
  /** 这一轮答完之后能接着问什么。最多三条，全部由这次回答提到的人生成 */
  const 追问 = !answer
    ? []
    : [
        ...answer.customers.slice(0, 2).map((c) => `${c.name}这边下一步该做什么`),
        ...(answer.customers.length > 0 && answer.proposals.length === 0 ? [`帮我给${answer.customers[0].name}排一次跟进`] : []),
      ].slice(0, 3);

  return (
    <div ref={ref} className="cli-turn">
      <div className="cli-user">
        <div className="cli-bubble">{turn.question}</div>
      </div>

      {turn.queued && (
        <div className="cli-step">
          <span className="cli-dot cli-dot-idle" />
          <span className="cli-step-l">排队中，等上一问答完</span>
          <button type="button" className="cli-link" onClick={onRemove}>
            取消
          </button>
        </div>
      )}

      {steps.length > 0 && done && (
        <button type="button" className={`cli-sum${open ? " cli-sum-open" : ""}`} onClick={() => setOpen((v) => !v)}>
          <span>{summarizeSteps(steps, b.customer)}</span>
          {ms ? <span className="cli-sum-ms">{(ms / 1000).toFixed(1)}s</span> : null}
          <RightOutlined className="cli-sum-chev" />
        </button>
      )}
      {showRows &&
        steps.map((s) => (
          <div key={s.id} className={`cli-step cli-step-${s.status}`}>
            <span className="cli-dot" />
            <span className="cli-step-b">
              <span className="cli-step-l">{s.label}</span>
              {s.detail && <span className="cli-step-d">{s.detail}</span>}
              {open && s.thought && <span className="cli-step-t">{s.thought}</span>}
            </span>
          </div>
        ))}
      {thinking && (
        <div className="cli-step cli-step-running">
          <span className="cli-dot" />
          <span className="cli-step-l cli-think">
            {writing ? "在写" : "在想"}
            <span className="cli-think-dots">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </span>
          <span className="cli-step-d">{elapsed}s · Esc 打断</span>
        </div>
      )}

      {text && (
        <div className="cli-a">
          <Markdown text={text} records={answer?.records ?? job?.value?.answer?.records ?? []} />
          {!done && <span className="cli-caret" />}
        </div>
      )}

      {/*
        **答不上来的时候别留死胡同。** 一天只有 3 次免费提问，一句「没查到，
        你给个更完整的姓名」当场吃掉三分之一，而人只剩「再问一次、再烧一次」这一条路。
        这里给一条**不走模型、一次额度都不花**的：直接去列表页搜那个词。
        摘不出词就不出现——把人送到一个搜「的」的列表页比不给这条路更糟。
      */}
      {done && 死胡同 && (
        <div className="cli-deadend">
          <span>没查到？</span>
          <Link className="cli-link" href={`/customers?keyword=${encodeURIComponent(死胡同.词)}`}>
            去库里搜「{死胡同.词}」
          </Link>
          <span className="cli-deadend-n">不算一次提问</span>
        </div>
      )}

      {答案没了 && (
        <div className="cli-stopped">
          <span className="cli-stop-mark" />
          这一条的回答不在了
          <button type="button" className="cli-link" onClick={onRetry}>
            再问一次
          </button>
        </div>
      )}

      {interrupted && (
        <div className="cli-stopped">
          <span className="cli-stop-mark" />
          已中断
          <button type="button" className="cli-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {job?.status === "error" && !interrupted && (
        <div className="cli-err">
          {job.error}
          <button type="button" className="cli-link" onClick={onRetry}>
            重试
          </button>
        </div>
      )}

      {answer && answer.proposals?.length > 0 && (
        <div className="prop-list">
          {answer.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} 记号={`home:${turn.id}:${p.id}`} />
          ))}
        </div>
      )}

      {answer && answer.customers.length > 0 && (
        <div className="cli-card">
          <div className="cli-card-h">
            涉及 {answer.customers.length} 位{b.customer}
          </div>
          {answer.customers.slice(0, 5).map((c) => (
            <CustomerRow key={c.id} customer={c} />
          ))}
        </div>
      )}

      {/*
        回答后面跟着下一步（照 eigent 那条：结果 → 简报 → 建议的后续）。
        追问只从**这次回答真的提到的人**里长出来，不凭空造两个问题挂在那儿——
        一个点不出东西的追问比没有追问更糟。
      */}
      {done && 追问.length > 0 && (
        <div className="cli-next">
          {追问.map((q) => (
            <button key={q} type="button" className="cli-q" onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {done && (
        <div className="cli-bar">
          {answer && (
            <Tooltip title="复制回答">
              <button
                type="button"
                className="cli-ic"
                aria-label="复制回答"
                onClick={async () => {
                  await navigator.clipboard.writeText(answer.text);
                  message.success("已复制");
                }}
              >
                <CopyOutlined />
              </button>
            </Tooltip>
          )}
          <Tooltip title="重新回答">
            <button type="button" className="cli-ic" aria-label="重新回答" onClick={onRetry}>
              <ReloadOutlined />
            </button>
          </Tooltip>
          <Tooltip title="移除这一轮">
            <button type="button" className="cli-ic" aria-label="移除这一轮" onClick={onRemove}>
              <CloseOutlined />
            </button>
          </Tooltip>
          <span className="cli-bar-t">{whenLabel(turn.at)}</span>
        </div>
      )}
    </div>
  );
}

/** 卡片里的一行：客户名、状态、动作；草稿就地展开，与记录页、盯盘、雷达共用同一份 */
function CustomerRow({ customer }: { customer: 提到的客户 }) {
  const 复制 = useCopyDraft();
  const wakeup = useJob<string>(草稿键("wakeup", customer.id));
  const invite = useJob<string>(草稿键("invite", customer.id));
  const run = (kind: 草稿类) => 起草(kind, customer.id, "从首页发起");
  return (
    <div className="cli-card-row">
      <div className="cli-card-main">
        <span className="cli-card-name">{customer.name}</span>
        {customer.followStatus && <span className="cli-card-st">{customer.followStatus}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="cli-link" onClick={() => run("wakeup")} disabled={wakeup?.status === "loading"}>
          {wakeup?.status === "loading" ? "起草中…" : "起草跟进话术"}
        </button>
        {customer.followStatus === "已签约" && (
          <button type="button" className="cli-link" onClick={() => run("invite")} disabled={invite?.status === "loading"}>
            {invite?.status === "loading" ? "起草中…" : "起草转介绍邀请"}
          </button>
        )}
        <Link href={`/customers/${customer.id}`} className="cli-link cli-card-open">
          打开 <RightOutlined style={{ fontSize: 10 }} />
        </Link>
      </div>
      {[
        { kind: "wakeup" as const, job: wakeup },
        { kind: "invite" as const, job: invite },
      ].map(({ kind, job }) =>
        job?.status === "done" && job.value ? (
          <div key={kind} className="cli-draft">
            <div>{job.value}</div>
            <div>
              <button type="button" className="cli-link" onClick={() => 复制(job.value!)}>
                复制
              </button>
              <button type="button" className="cli-link" onClick={() => clearJob(草稿键(kind, customer.id))}>
                收起
              </button>
            </div>
          </div>
        ) : job?.status === "error" ? (
          <div key={kind} className="cli-err">
            {job.error}
          </div>
        ) : null,
      )}
    </div>
  );
}
