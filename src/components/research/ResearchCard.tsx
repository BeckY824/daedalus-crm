"use client";

/**
 * 背调卡：首页对话和记录页右栏共用。只管「把 背调状态 画出来」，不管它从哪来（流式事件 / 历史 / 测试）。
 *
 * 从原型 /lab/research 搬过来的六种做法（照 Attio 首页拆的）：
 *   1. 工具组：一句打算逐字出来，每次搜索 / 读页一张小卡（图标 · 动作 · 结果 · 耗时），点开看来源
 *   2. 跑着的那一步用流光字，做完弹出勾，左边进度线跟着长；做完的折成一行结论，点开看过程
 *   3. 档案格一格一格填（没到的是骨架条），不是一大段字
 *   4. 相关性分数滚上去，外圈跟着画；信号 / 风险一条条出来
 *   5. 来源统一编号，结论后面的 [n] 点了用系统浏览器打开那一页
 *   6. 底部状态条：用时、搜了几次、读了几页、扣几次背调（没跑完退回的照实说）
 * 2026-10-18 加「真实性」块（不进 100 分，灯由代码定：lib/research/verify/rules.ts）和「信息少，谨慎」横幅。
 * 动效只表达真实进度：每个变化都对应一条事件（lib/research/types.ts 研究事件）。
 * 时长、曲线一律取 useMotionTheme()；开了「减弱动态」时 MotionConfig 撤位移，样式表撤扫光（research.css 末尾）。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useMotionTheme } from "@/components/MotionTheme";
import { 思考打字 } from "@/lib/motion";
import { 阶段表, 字段表, 必查表, type 工具事件 } from "@/lib/research/types";
import { 补标题, 来源号, type 背调状态, type 阶段状态 } from "@/lib/research/state";
import { 核验项表, type 灯, type 真实性 } from "@/lib/research/verify/types";
import { 信息少 } from "@/lib/research/verify/rules";
import "./research.css";

const 档名 = { high: "高", mid: "中", low: "低", unknown: "查不到" } as const;
const 风险名 = { low: "低", mid: "中", high: "高" } as const;

/** 跑着的那一步：灰字上叠一层扫过去的高光 */
function Shimmer({ text }: { text: string }) {
  return (
    <span className="rs-shimmer" data-text={text}>
      {text}
    </span>
  );
}

/** 一句打算逐字出来；打完光标收掉。换一句由调用处换 key 重挂 */
function TypeOut({ text, className }: { text: string; className?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const 间 = Math.max(1, Math.round(思考打字.每字 * 1000));
    const id = window.setInterval(() => setN((k) => (k >= text.length ? (window.clearInterval(id), k) : k + 1)), 间);
    return () => window.clearInterval(id);
  }, [text]);
  return (
    <span className={className}>
      {text.slice(0, n)}
      {n < text.length && <span className="rs-caret" />}
    </span>
  );
}

function ToolIcon({ kind }: { kind: "search" | "read" }) {
  return kind === "search" ? (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path d="M4 1.75h5.5L12.25 4.5v9.75H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 7.5h4M6 10h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** [n]：来源角标。不在来源表里就不画 */
export function Ref({ s, url }: { s: 背调状态; url?: string }) {
  const n = 来源号(s, url);
  if (!n || !url) return null;
  return (
    <a className="rs-ref" href={url} target="_blank" rel="noreferrer" title={url}>
      [{n}]
    </a>
  );
}

export function ToolCard({ t }: { t: 工具事件 }) {
  const { 时长, 曲线 } = useMotionTheme();
  const [开, set开] = useState(false);
  const 有来源 = t.status === "done" && (t.sources?.length ?? 0) > 0;
  return (
    <motion.div className={`rs-tool rs-tool-${t.status}`} layout="position" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 时长.base, ease: 曲线.ease }}>
      <button type="button" className="rs-tool-head" onClick={() => 有来源 && set开((v) => !v)} disabled={!有来源} aria-expanded={有来源 ? 开 : undefined}>
        <span className="rs-tool-icon">{t.status === "running" ? <span className="rs-spin" /> : <ToolIcon kind={t.kind} />}</span>
        <span className="rs-tool-label">{t.status === "running" ? <Shimmer text={t.label} /> : t.label}</span>
        {t.status !== "running" && (
          <span className="rs-tool-result">
            {t.result}
            {t.ms ? <span className="rs-tool-ms"> · {(t.ms / 1000).toFixed(1)}s</span> : null}
          </span>
        )}
        {有来源 && <span className={`rs-chev ${开 ? "rs-open" : ""}`}>›</span>}
      </button>
      <AnimatePresence initial={false}>
        {开 && (
          <motion.ul className="rs-tool-srcs" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 时长.morph, ease: 曲线.morph }}>
            {t.sources!.map((x) => (
              <li key={x.url}>
                <a href={x.url} target="_blank" rel="noreferrer">
                  {x.title}
                </a>
                <span className="rs-url">{x.url.replace(/^https?:\/\//, "")}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** 阶段左边那颗点：空心 → 转圈 → 弹出来的勾；出错是一颗红点 */
function StageNode({ status }: { status: 阶段状态["status"] }) {
  const { 时长, 曲线 } = useMotionTheme();
  return (
    <span className={`rs-node rs-node-${status}`}>
      <AnimatePresence initial={false} mode="popLayout">
        {status === "running" && <motion.span key="run" className="rs-node-ring" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />}
        {status === "done" && (
          <motion.svg key="ok" viewBox="0 0 16 16" width="16" height="16" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 时长.morph, ease: 曲线.spring }}>
            <circle cx="8" cy="8" r="8" fill="var(--brand)" />
            <motion.path d="M4.6 8.3 7 10.6l4.4-5" fill="none" stroke="var(--on-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 时长.morph, ease: 曲线.ease }} />
          </motion.svg>
        )}
      </AnimatePresence>
    </span>
  );
}

function StageRow({ label, s }: { label: string; s: 阶段状态 }) {
  const { 时长, 曲线 } = useMotionTheme();
  const [展开, set展开] = useState(false);
  const 跑着 = s.status === "running";
  const 搜 = s.tools.filter((t) => t.kind === "search").length;
  const 读 = s.tools.filter((t) => t.kind === "read").length;
  const 摘要 = [搜 ? `搜 ${搜}` : null, 读 ? `读 ${读} 页` : null].filter(Boolean).join(" · ");
  const 可展开 = s.status === "done" || s.status === "error";
  const 显示过程 = 跑着 || 展开;
  return (
    <li className={`rs-stage rs-stage-${s.status}`}>
      <StageNode status={s.status} />
      <div className="rs-stage-main">
        <button type="button" className="rs-stage-head" onClick={() => 可展开 && set展开((v) => !v)} disabled={!可展开} aria-expanded={可展开 ? 展开 : undefined}>
          <span className="rs-stage-label">{跑着 ? <Shimmer text={label} /> : label}</span>
          <AnimatePresence initial={false}>
            {可展开 && s.summary && (
              <motion.span className="rs-stage-detail" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 时长.base, ease: 曲线.ease }}>
                {s.summary}
              </motion.span>
            )}
          </AnimatePresence>
          {可展开 && 摘要 && <span className="rs-stage-sum">{摘要}</span>}
        </button>
        <AnimatePresence initial={false}>
          {显示过程 && (s.thought || s.tools.length > 0) && (
            <motion.div className="rs-stage-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 时长.morph, ease: 曲线.morph }}>
              {s.thought && (跑着 ? <TypeOut key={s.thought} text={s.thought} className="rs-thought" /> : <span className="rs-thought">{s.thought}</span>)}
              <div className="rs-tools">
                {s.tools.map((t) => (
                  <ToolCard key={t.id} t={t} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}

/** 分数滚上去，外圈跟着画 */
function FitScore({ value }: { value: number }) {
  const { 时长, 曲线 } = useMotionTheme();
  const v = useMotionValue(0);
  const 字 = useTransform(v, (x) => Math.round(x).toString());
  const 弧 = useTransform(v, (x) => x / 100);
  useEffect(() => {
    const c = animate(v, value, { duration: 时长.morph, ease: 曲线.ease });
    return () => c.stop();
  }, [value, v, 时长.morph, 曲线.ease]);
  return (
    <div className="rs-score" role="img" aria-label={`相关性 ${value} 分`}>
      <svg viewBox="0 0 44 44" width="56" height="56" aria-hidden>
        <circle cx="22" cy="22" r="19" fill="none" stroke="var(--line-soft)" strokeWidth="4" />
        <motion.circle cx="22" cy="22" r="19" fill="none" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" style={{ pathLength: 弧, rotate: -90, transformOrigin: "50% 50%" }} />
      </svg>
      <motion.span className="rs-score-num">{字}</motion.span>
    </div>
  );
}

const 灯名: Record<灯, string> = { green: "可信", yellow: "留意", red: "高危", gray: "没法判断" };
const 项名 = Object.fromEntries(核验项表.map((x) => [x.key, x.label])) as Record<string, string>;

/** 真实性：一项一盏灯。灯和事实全是代码直查出来的，模型只写下面那一句总结 */
function TrustBlock({ v }: { v: 真实性 }) {
  const { 时长, 曲线, 间隔 } = useMotionTheme();
  return (
    <motion.div className={`rs-trust rs-trust-${v.总灯}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 时长.morph, ease: 曲线.ease }}>
      <div className="rs-trust-head">
        <span className="rs-trust-t">真实性</span>
        <span className={`rs-light rs-light-${v.总灯}`}>
          <span className="rs-dot" aria-hidden />
          {灯名[v.总灯]}
        </span>
        <span className="rs-trust-sum">{v.总字}</span>
        <span className="rs-trust-by" title="这一块的灯和每一条事实都是程序直接查官方接口得来的，没经过 AI，也不计入相关性分">
          程序直查 · 不经模型
        </span>
      </div>
      {v.总结 && <p className="rs-trust-note">{v.总结}</p>}
      <ul className="rs-checks">
        {v.项.map((x, i) => (
          <motion.li key={x.key} className={`rs-check rs-check-${x.灯}`} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 时长.base, ease: 曲线.ease, delay: i * 间隔 }}>
            <span className="rs-dot" aria-label={灯名[x.灯]} />
            <span className="rs-check-l">{项名[x.key] ?? x.key}</span>
            <span className="rs-check-f">
              {x.事实}
              {x.链接?.map((l) => (
                <a key={l.url} className="rs-check-a" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                  {l.title}
                </a>
              ))}
            </span>
          </motion.li>
        ))}
      </ul>
      {v.名单更新于 && <p className="rs-trust-foot">制裁名单（美国 OFAC、欧盟、联合国、英国）更新于 {v.名单更新于.slice(0, 10)}</p>}
    </motion.div>
  );
}

/** 跑着时秒表自己走；跑完停在总用时 */
function 用秒(running: boolean, 起: number | undefined, 总?: number): number {
  return 总 != null ? 总 / 1000 : running && 起 ? (Date.now() - 起) / 1000 : 0;
}

/** 英文开发信：原样显示，一键复制（主题 + 正文） */
function EmailBlock({ 主题, 正文 }: { 主题: string; 正文: string }) {
  const [复制了, set复制了] = useState(false);
  const 复制 = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${主题}\n\n${正文}`);
      set复制了(true);
      window.setTimeout(() => set复制了(false), 1500);
    } catch {
      set复制了(false);
    }
  };
  return (
    <div className="rs-email">
      <div className="rs-email-head">
        <p className="rs-block-t">英文开发信</p>
        <button type="button" className="rs-btn" onClick={复制}>
          {复制了 ? "已复制" : "复制开发信"}
        </button>
      </div>
      <div className="rs-email-subj">Subject: {主题}</div>
      <div className="rs-email-body" lang="en">
        {正文}
      </div>
    </div>
  );
}

export type ResearchCardProps = {
  s: 背调状态;
  /** 还在跑 */
  running: boolean;
  /** 出错 / 被打断时那一句 */
  error?: string;
  起?: number;
  ms?: number;
  /** 卡片底部的按钮（存进客户、记跟进……），由外面给：首页和记录页的动作不一样 */
  actions?: React.ReactNode;
};

export default function ResearchCard({ s, running, error, 起, ms, actions }: ResearchCardProps) {
  const { 时长, 曲线, 间隔 } = useMotionTheme();
  const [, 走] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => 走((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [running]);

  const 完成数 = 阶段表.filter((x) => s.stages[x.id].status === "done").length;
  const 官网 = s.fields.site?.value;
  const 来源 = 补标题(s);
  const 信号 = s.tags.filter((t) => t.tone === "signal");
  const 风险 = s.tags.filter((t) => t.tone === "risk");
  const 状态字 = running ? null : error ? (s.done ? "材料不全" : "没跑完") : s.done?.不完整 ? "材料不全" : s.done ? "已完成" : null;
  const 状态类 = !running && error && !s.done ? "rs-pill-err" : s.done?.不完整 || error ? "rs-pill-part" : "rs-pill-done";
  const 字段们 = 字段表.filter((f) => f.key !== "site");
  const 少 = 信息少(s);

  return (
    <section className="rs-card" aria-label={`背调 ${s.目标.name}`}>
      <div className="rs-head">
        <span className="rs-logo" aria-hidden>
          {s.目标.name.trim().charAt(0).toUpperCase()}
        </span>
        <div className="rs-head-main">
          <div className="rs-name">{s.目标.name}</div>
          <div className="rs-domain">
            {官网 ? (
              <a href={/^https?:/.test(官网) ? 官网 : `https://${官网}`} target="_blank" rel="noreferrer">
                {官网}
              </a>
            ) : running ? (
              "正在确认官网…"
            ) : (
              "没找到官网"
            )}
            {s.fields.country && <> · {s.fields.country.value}</>}
          </div>
        </div>
        <span className={`rs-pill ${running ? "" : 状态类}`}>{running ? <Shimmer text="背调中" /> : 状态字}</span>
      </div>

      {少 && (
        <div className="rs-thin" role="note">
          <b>信息少，谨慎</b>
          <span>{少.文字}</span>
        </div>
      )}

      {/* 只有人名 + 电话、从搜索结果认出这家再背调的（lib/research/person.ts）：开头写清楚是怎么认出来的 */}
      {s.人?.选了 && (
        <p className="rs-from-person">
          询盘人{s.人.名 ? ` ${s.人.名}` : ""}（{s.人.号.号}，{s.人.号.国名}
          {s.人.号.类型}）没给公司名，是从
          {s.人.候选?.[0]?.号码对上 ? "号码" : "名字"}在网上认出这家、你点选的：{s.人.候选?.[0]?.依据}
          <Ref s={s} url={s.人.候选?.[0]?.来源.url} />
        </p>
      )}

      <dl className="rs-fields">
        {字段们.map((f) => {
          const v = s.fields[f.key];
          return (
            <div key={f.key} className="rs-field">
              <dt>{f.label}</dt>
              <dd>
                <AnimatePresence initial={false} mode="wait">
                  {v ? (
                    <motion.span key="v" initial={{ opacity: 0, y: 4, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 时长.morph, ease: 曲线.ease }}>
                      {v.value}
                      <Ref s={s} url={v.source} />
                    </motion.span>
                  ) : running ? (
                    <motion.span key="sk" className="rs-skeleton" exit={{ opacity: 0 }} transition={{ duration: 时长.fast }} />
                  ) : (
                    <span className="rs-none">查不到</span>
                  )}
                </AnimatePresence>
              </dd>
            </div>
          );
        })}
        {s.进口 && (
          <div className="rs-field">
            <dt>进口记录</dt>
            <dd>
              {s.进口.有 ? (
                <span>
                  {s.进口.摘要}
                  <Ref s={s} url={s.进口.source} />
                </span>
              ) : (
                <span className="rs-none">未查到公开进口记录</span>
              )}
            </dd>
          </div>
        )}
        {s.联系人 && s.联系人.length > 0 && (
          <div className="rs-field">
            <dt>公开联系人</dt>
            <dd>
              <ul className="rs-plain">
                {s.联系人.map((c) => (
                  <li key={`${c.姓名 ?? ""}${c.邮箱 ?? ""}${c.电话 ?? ""}`}>
                    {[c.岗位, c.姓名, c.电话, c.邮箱].filter(Boolean).join(" · ")}
                    <Ref s={s} url={c.source} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {s.型号 && s.型号.length > 0 && (
          <div className="rs-field">
            <dt>在卖的型号</dt>
            <dd>
              <ul className="rs-plain">
                {s.型号.map((m) => (
                  <li key={m.型号}>
                    <b>{m.型号}</b>
                    {m.是什么 ? `：${m.是什么}` : ""}
                    <Ref s={s} url={m.source} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>

      <AnimatePresence>{s.真实性 && <TrustBlock v={s.真实性} />}</AnimatePresence>

      <div className="rs-rail-wrap">
        <span className="rs-rail" aria-hidden>
          <motion.span className="rs-rail-fill" animate={{ scaleY: 完成数 / 阶段表.length }} transition={{ duration: 时长.morph, ease: 曲线.ease }} />
        </span>
        <ol className="rs-stages">
          {阶段表.map((x) => (
            <StageRow key={x.id} label={x.label} s={s.stages[x.id]} />
          ))}
        </ol>
      </div>

      <AnimatePresence>
        {s.评分 && (
          <motion.div className="rs-fit" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 时长.morph, ease: 曲线.ease }}>
            {s.评分.分 != null ? <FitScore value={s.评分.分} /> : <div className="rs-score"><span className="rs-score-num">—</span></div>}
            <div>
              <div className="rs-fit-title">
                和我们的相关性
                {s.评分.信息不足 && <span className="rs-fit-note">信息不足，仅供参考</span>}
                {s.真实性 && (
                  <span className={`rs-light rs-light-${s.真实性.总灯} rs-fit-light`} title="真实性单独看，不计入这个分">
                    <span className="rs-dot" aria-hidden />
                    真实性{灯名[s.真实性.总灯]}
                  </span>
                )}
              </div>
              {s.评分.结论 && <div className={`rs-verdict rs-verdict-${s.评分.结论.档}`}>{s.评分.结论.字}</div>}
              {s.评分.封顶 && (
                <div className="rs-cap">
                  按权重算 {s.评分.原分} 分，封顶 {s.评分.封顶.上限} 分：{s.评分.封顶.原因.join("；")}
                </div>
              )}
              <ul className="rs-dims">
                {s.评分.明细.map((d, i) => (
                  <motion.li key={d.维度} className="rs-dim" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 时长.base, ease: 曲线.ease, delay: i * 间隔 }}>
                    <span className="rs-dim-l">{d.label}</span>
                    <span className={`rs-grade rs-grade-${d.档}`}>{档名[d.档]}</span>
                    <span className="rs-dim-e">
                      {d.证据}
                      <Ref s={s} url={d.来源} />
                    </span>
                  </motion.li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {s.similar && (
        <div>
          <p className="rs-block-t">像你的老客户</p>
          {s.similar.items.length ? (
            <div className="rs-similar">
              {s.similar.items.map((c) => (
                <div key={c.id} className="rs-sim">
                  <Link href={`/customers/${c.id}`}>{c.name}</Link>
                  <span className={`rs-grade rs-grade-${c.档}`}>{档名[c.档]}</span>
                  <span className="rs-sim-why">{c.像在哪}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="rs-none">{s.similar.比了 ? `比了 ${s.similar.比了} 位已成交 / 在谈的客户，没有特别像的` : "还没有已成交或在谈的客户可以比"}</span>
          )}
        </div>
      )}

      {s.必查 && s.必查.length > 0 && (
        <div>
          <p className="rs-block-t">风险必查</p>
          <ul className="rs-musts">
            {s.必查.map((x) => (
              <li key={x.key} className={`rs-must rs-${x.级别}`}>
                <span className="rs-must-l">{必查表.find((k) => k.key === x.key)?.label ?? x.key}</span>
                <span className={x.source ? "" : "rs-none"}>
                  {x.级别 !== "none" && <span className="rs-must-lv">{风险名[x.级别]}</span>}
                  {x.结论}
                  <Ref s={s} url={x.source} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(信号.length > 0 || 风险.length > 0 || s.stages.risks.status === "done") && (
        <div className="rs-tags">
          <AnimatePresence initial={false}>
            {信号.map((t) => (
              <motion.div key={`s-${t.text}`} className="rs-tag rs-tag-signal" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 时长.morph, ease: 曲线.spring }}>
                <span className="rs-tag-mark">信号</span>
                <span>
                  {t.text}
                  <Ref s={s} url={t.source} />
                </span>
              </motion.div>
            ))}
            {风险.map((t) => (
              <motion.div key={`r-${t.text}`} className={`rs-tag rs-tag-risk rs-${t.level ?? "low"}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 时长.morph, ease: 曲线.spring }}>
                <span className="rs-tag-mark">风险{t.level ? `·${风险名[t.level]}` : ""}</span>
                <span>
                  {t.text}
                  <Ref s={s} url={t.source} />
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          {!风险.length && !s.必查?.some((x) => x.级别 !== "none") && s.stages.risks.status === "done" && (
            <div className="rs-tag">
              <span className="rs-none">没查到明显风险</span>
            </div>
          )}
        </div>
      )}

      {s.approach.length > 0 && (
        <div>
          <p className="rs-block-t">切入建议</p>
          <ol className="rs-approach">
            {s.approach.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </div>
      )}

      {s.型号对比 && s.型号对比.length > 0 && (
        <div>
          <p className="rs-block-t">型号对比</p>
          <ul className="rs-plain rs-compare">
            {s.型号对比.map((c) => (
              <li key={c.对方}>
                <b>{c.对方}</b> ↔ 我们的{c.我们}：{c.怎么比}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.开发信 && <EmailBlock 主题={s.开发信.主题} 正文={s.开发信.正文} />}

      {来源.length > 0 && !running && (
        <div>
          <p className="rs-block-t">来源</p>
          <ul className="rs-srcs">
            {来源.map((x, i) => (
              <li key={x.url}>
                <span className="rs-n">[{i + 1}]</span>
                <a href={x.url} target="_blank" rel="noreferrer" title={x.url}>
                  {x.title === x.url ? x.url.replace(/^https?:\/\//, "") : x.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={`rs-status ${running ? "" : "rs-status-done"}`}>
        <span className="rs-status-dot" />
        <span className="rs-num">{用秒(running, 起, ms).toFixed(1)}s</span>
        <span>
          搜索 <b className="rs-num">{s.usage.searches}</b> 次
        </span>
        <span>
          读了 <b className="rs-num">{s.usage.pages}</b> 页
        </span>
        {/* 背调次数和问答的 AI 次数分开记。没跑完是我们这边的原因（超时、上游报错）时服务器退了那 1 次，照实说 */}
        {s.done && s.done.charge > 0 &&
          (s.done.退了 ? <span className="rs-charge">没跑完，已退回这 {s.done.charge} 次背调</span> : <span className="rs-charge">扣 {s.done.charge} 次背调</span>)}
        {s.done && s.done.charge === 0 && s.人?.选了 && <span className="rs-charge">找公司时已扣 1 次，接着背调不另扣</span>}
      </div>

      {error && !running && <div className="rs-err">{error}</div>}
      {actions}
    </section>
  );
}
