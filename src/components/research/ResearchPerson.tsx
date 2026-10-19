"use client";

/**
 * 只有「人名 + 电话 / WhatsApp」、没有公司的那一轮（lib/research/person.ts）：
 *   开跑前    号码本机判（哪国、手机还是固话，不花钱不扣次数），写明「开始搜索后扣 1 次」；也可以说「这其实是公司名」
 *   找公司    搜号码、搜名字，一张张工具卡（和背调卡同一套）
 *   有候选    列出来点选：点哪家就接着背调哪家，同一次，不另扣（HomeChat 把这一轮换成那家公司的背调卡）
 *   没有 / 都不是  「只有人」的简版：号码归属国和类型、号码 / 名字在网上出现过的页面、「信息少，谨慎」和建议。
 *                 没认出公司、只出简版的不扣次数（10-19 用户）；认出了候选、人点「都不是」的照扣（候选本身就是认出了公司）
 * 只列和做生意有关的公开页面（公司官网、名录、B2B 平台、LinkedIn、Facebook 公司页），私人社交不列。
 */
import { useEffect, useState } from "react";
import { App } from "antd";
import { ToolCard, Ref } from "./ResearchCard";
import { useJob, clearJob } from "@/lib/ai-jobs";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import { 背调价目, 认号码动作 } from "@/lib/research/actions";
import type { 背调状态 } from "@/lib/research/state";
import type { 候选公司, 出现, 号码信息 } from "@/lib/research/person";
import type { 搜索结果 } from "@/lib/research/types";
import { 报告文本 } from "@/lib/research/report";
import "./research.css";

type 价目 = Awaited<ReturnType<typeof 背调价目>>;
export type 找人答案 = { text: string; research: 背调状态; runId?: string; 材料?: 搜索结果[] };

export default function ResearchPerson({
  jobKey,
  名,
  电话,
  需求,
  onPick,
  onAsCompany,
  onCancel,
  任务去,
}: {
  jobKey: string;
  名?: string;
  电话: string;
  需求?: string;
  /** 点了一家候选：接着背调它（同一个 runId，不另扣）。证据 = 认出它的那几条搜索结果，带进背调的材料里 */
  onPick: (c: 候选公司, runId: string, 证据: 搜索结果[], 出现: 出现) => void;
  /** 「这其实是公司名」：按公司直接背调 */
  onAsCompany?: (公司: string) => void;
  onCancel?: () => void;
  任务去?: string;
}) {
  const job = useJob<StreamJob<找人答案>>(jobKey);
  const running = job?.status === "loading";
  const s = job?.value?.answer?.research ?? job?.value?.research;
  const 开跑 = () => runStream<找人答案>(jobKey, { mode: "research", person: { name: 名, phone: 电话 }, need: 需求 }, undefined, { 名: `找 ${名 || 电话} 的公司`.slice(0, 18), 去: 任务去 });
  if (!job) return <Confirm 名={名} 电话={电话} onStart={开跑} onAsCompany={onAsCompany} onCancel={onCancel} />;
  if (!s?.人) return job.status === "error" ? <div className="rs-err">{job.error}</div> : <div className="rs-confirm"><span className="rs-confirm-t">开始找公司…</span></div>;
  const runId = job.value?.answer?.runId;
  const 证据 = job.value?.answer?.材料 ?? [];
  return <PersonCard s={s} running={running} error={job.status === "error" ? job.error : undefined} onPick={runId ? (c) => onPick(c, runId, 证据.filter((r) => r.url === c.来源.url), s.人?.出现 ?? { 号码: [], 名字: [] }) : undefined} onStop={() => cancelStream(jobKey)} onRetry={() => clearJob(jobKey)} />;
}

function Confirm({ 名, 电话, onStart, onAsCompany, onCancel }: { 名?: string; 电话: string; onStart: () => void; onAsCompany?: (公司: string) => void; onCancel?: () => void }) {
  const [价, set价] = useState<价目 | null>(null);
  const [号, set号] = useState<号码信息 | null | undefined>(undefined);
  useEffect(() => {
    let 活 = true;
    背调价目()
      .then((r) => 活 && set价(r))
      .catch(() => 活 && set价({ 可用: false, 原因: "问不到背调服务，稍后再试" }));
    认号码动作(电话)
      .then((r) => 活 && set号(r))
      .catch(() => 活 && set号(null));
    return () => {
      活 = false;
    };
  }, [电话]);
  if (!价 || 号 === undefined) return <div className="rs-confirm"><span className="rs-confirm-t">正在看这个号码…</span></div>;
  const 不够 = 价.可用 && 价.还剩 != null && 价.还剩 < 价.扣次;
  return (
    <div className="rs-confirm rs-pick" role="group" aria-label="找这个人所在的公司">
      <span className="rs-confirm-t">
        只有{名 ? <>名字 <b>{名}</b> 和</> : null}电话 <b>{号?.号 ?? 电话}</b>
        {号 ? `（${号.国名}${号.类型}${号.有效 ? "" : "，号码位数不对"}）` : "（号码认不出，要 + 开头的国际号码）"}，没有公司名。
        {号?.虚构 ? (
          <>
            <b className="rs-warn">这是虚构号码</b>（{号.虚构}），不会分给任何真实用户，对方留的联系方式不可信。
            {名 ? `只按名字「${名}」搜，不拿这个号码认公司。` : "只有这个号码，没法找公司，先向对方要真实的公司电话和公司邮箱。"}
          </>
        ) : (
          <>先上网搜这个号码{名 ? "和名字" : ""}，找到候选公司让你点选，再接着背调那家。</>
        )}
        {价.可用 ? (
          价.模拟 ? (
            "（开发环境，用模拟数据，不扣次数）"
          ) : (
            <>
              判号码不扣次数；<b>开始搜索后扣 1 次背调</b>
              {价.还剩 != null && <>（你还剩 {价.还剩} 次）</>}，点选候选、接着背调都算这一次，不另扣；没认出公司、只出了简版的不扣（认出了候选、你都没选的照扣）。
              {不够 && "背调次数用完了，需要加次数请联系我们。"}
            </>
          )
        ) : (
          <>背调用不了：{价.原因}</>
        )}
        <span className="rs-pick-n">（还没扣次数）</span>
      </span>
      <div className="rs-pick-row">
        <button type="button" className="rs-btn rs-btn-primary" onClick={onStart} disabled={!价.可用 || 不够 || !号 || Boolean(号.虚构 && !名)}>
          开始找公司
        </button>
        {名 && onAsCompany && (
          <button type="button" className="rs-btn" onClick={() => onAsCompany(名)}>
            「{名}」其实是公司名，直接背调
          </button>
        )}
        {onCancel && (
          <button type="button" className="rs-btn" onClick={onCancel}>
            算了
          </button>
        )}
      </div>
    </div>
  );
}

export function PersonCard({ s, running, error, onPick, onStop, onRetry }: { s: 背调状态; running: boolean; error?: string; onPick?: (c: 候选公司) => void; onStop?: () => void; onRetry?: () => void }) {
  const { message } = App.useApp();
  const [都不是, set都不是] = useState(false);
  const 人 = s.人!;
  const 候选 = 人.候选 ?? [];
  const 找完 = !running && 人.出现 !== undefined;
  const 简版 = 找完 && (!候选.length || 都不是);
  const 复制 = async () => {
    await navigator.clipboard.writeText(报告文本(s));
    message.success("已复制");
  };
  return (
    <section className="rs-card" aria-label={`找 ${人.名 ?? 人.号.号} 的公司`}>
      <div className="rs-head">
        <span className="rs-logo" aria-hidden>
          {(人.名 ?? "#").trim().charAt(0).toUpperCase()}
        </span>
        <div className="rs-head-main">
          <div className="rs-name">{人.名 ?? 人.号.号}</div>
          <div className="rs-domain">
            {人.号.号} · {人.号.国名}
            {人.号.类型}
          </div>
        </div>
        <span className={`rs-pill ${running ? "" : 简版 ? "rs-pill-part" : "rs-pill-done"}`}>{running ? "找公司中" : 简版 ? "只有人" : 候选.length ? "选一家" : "没跑完"}</span>
      </div>

      {简版 && (
        <div className="rs-thin" role="note">
          <b>信息少，谨慎</b>
          <span>没有公司名，{候选.length ? "候选公司你都没选" : "网上也没认出这个人 / 这个号码属于哪家公司"}。下面只有号码本身能核的几样。</span>
        </div>
      )}

      <div className="rs-tools">
        {人.tools.map((t) => (
          <ToolCard key={t.id} t={t} />
        ))}
      </div>

      {找完 && 候选.length > 0 && !都不是 && (
        <div>
          <p className="rs-block-t">认出的公司（点一家接着背调，不另扣）</p>
          <ul className="rs-cands">
            {候选.map((c) => (
              <li key={c.公司} className="rs-cand">
                <div className="rs-cand-main">
                  <b>{c.公司}</b>
                  {c.职位 && <span className="rs-cand-role">{c.职位}</span>}
                  <span className="rs-cand-why">
                    {c.依据}
                    <Ref s={s} url={c.来源.url} />
                  </span>
                  <span className="rs-cand-tags">
                    {c.号码对上 && <span className="rs-grade rs-grade-high">号码对上</span>}
                    {c.名字对上 && <span className="rs-grade rs-grade-mid">名字对上</span>}
                  </span>
                </div>
                {onPick && (
                  <button type="button" className="rs-btn rs-btn-primary" onClick={() => onPick(c)}>
                    背调这家
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="rs-btn" onClick={() => set都不是(true)}>
            都不是，只看这个人
          </button>
        </div>
      )}

      {简版 && 人.出现 && (
        <div className="rs-brief">
          <p className="rs-block-t">号码 {人.号.号}</p>
          <p>
            {人.号.国名}
            {人.号.类型}
            {人.号.有效 ? "" : "（号码位数不对，可能写错了）"}；
            {人.号.虚构 && <b className="rs-warn">这是虚构号码（{人.号.虚构}），不会分给任何真实用户；</b>}
            {人.出现.号码.length ? `在 ${人.出现.号码.length} 个公开页面上出现过：` : "公开网页上没搜到这个号码。"}
          </p>
          {人.出现.号码.length > 0 && <Links s={s} 列={人.出现.号码} />}
          {人.名 && (
            <>
              <p className="rs-block-t">名字 {人.名}</p>
              <p>{人.出现.名字.length ? `在 ${人.出现.名字.length} 个和做生意有关的公开页面上出现过（同名的人可能很多）：` : "和做生意有关的公开页面上没搜到这个名字。"}</p>
              {人.出现.名字.length > 0 && <Links s={s} 列={人.出现.名字} />}
            </>
          )}
          <p className="rs-block-t">建议</p>
          <ol className="rs-approach">
            {(人.建议 ?? []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
          <p className="rs-none">WhatsApp 没有公开查询的渠道，这里只看号码在搜索结果里出没出现过，没有登录、没有抓取。</p>
        </div>
      )}

      <div className={`rs-status ${running ? "" : "rs-status-done"}`}>
        <span className="rs-status-dot" />
        <span>
          搜索 <b className="rs-num">{s.usage.searches}</b> 次
        </span>
        {s.done && s.done.charge > 0 && (s.done.退了 ? <span className="rs-charge">{简版 ? "只出了简版，这次不扣次数" : `没跑完，已退回这 ${s.done.charge} 次背调`}</span> : <span className="rs-charge">扣 {s.done.charge} 次背调</span>)}
        {!s.done && 候选.length > 0 && !running && <span className="rs-charge">{都不是 ? "已扣 1 次背调（认出过候选公司）" : "已扣 1 次背调，接着背调不另扣"}</span>}
      </div>
      {error && !running && <div className="rs-err">{error}</div>}
      <div className="rs-actions">
        {running ? (
          <button type="button" className="rs-btn" onClick={onStop}>
            停下
          </button>
        ) : (
          <>
            {简版 && (
              <button type="button" className="rs-btn" onClick={复制}>
                复制
              </button>
            )}
            {error && onRetry && (
              <button type="button" className="rs-btn" onClick={onRetry}>
                重新找
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Links({ s, 列 }: { s: 背调状态; 列: { title: string; url: string }[] }) {
  return (
    <ul className="rs-srcs">
      {列.map((x) => (
        <li key={x.url}>
          <Ref s={s} url={x.url} />
          <a href={x.url} target="_blank" rel="noreferrer" title={x.url}>
            {x.title === x.url ? x.url.replace(/^https?:\/\//, "") : x.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
