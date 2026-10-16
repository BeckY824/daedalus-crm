"use client";

/**
 * 一次背调的整个生命周期：开跑前确认 → 流式展开 → 跑完给按钮（存进客户 / 记跟进 / 打开客户 / 复制）。
 * 首页对话（TurnView）和记录页右栏（AiPanel）都用它，只是 jobKey 和「记跟进」怎么开不一样。
 *
 * 状态挂在 ai-jobs 上（key 由外面给），不在组件 state 里：切去别的页面再回来，转圈还在转、卡还在。
 *
 * **开跑前一定先问**（2026-09-18「AI 不许自动跑」那条）：说清这次扣几次、还剩几次，点「开始」才跑。
 * 这台机器背调不了（没登录云端账号）就在这一步说清楚，不让人点了才知道。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { App } from "antd";
import ResearchCard from "./ResearchCard";
import { useJob, clearJob } from "@/lib/ai-jobs";
import { useBusiness } from "@/lib/business-client";
import { runStream, cancelStream, type StreamJob } from "@/lib/ai-stream";
import type { 背调状态 } from "@/lib/research/state";
import { 报告文本 } from "@/lib/research/report";
import { 背调价目, 存背调到客户, 新建客户并存背调, 找同名客户, 认联系方式 } from "@/lib/research/actions";

export type 背调答案 = { text: string; research: 背调状态; customers: { id: string; name: string; followStatus: string }[] };

type 价目 = Awaited<ReturnType<typeof 背调价目>>;

export default function ResearchRun({
  jobKey,
  company,
  customer,
  on记跟进,
  onCancel,
  任务去,
}: {
  jobKey: string;
  company: string;
  /** 从记录页发起的：背调的就是这位，「存进客户」直接存他名下 */
  customer?: { id: string; name: string };
  /** 记录页给：就地打开跟进表单。首页不给，存好以后跳去那位客户的页面记 */
  on记跟进?: () => void;
  /** 确认卡上点「取消」 */
  onCancel?: () => void;
  /** 侧栏「AI 任务」里点这一条回到哪 */
  任务去?: string;
}) {
  const job = useJob<StreamJob<背调答案>>(jobKey);
  const running = job?.status === "loading";
  const 原 = job?.value?.answer?.research ?? job?.value?.research;
  /*
    人点了「停下」：连接断了，服务端那头用已查到的材料收尾（不退次数，见 lib/research/run.ts），
    但收尾的那几条事件这边收不到了。已经查到过东西的，就地当成一份「材料不全」的报告——能存、能复制；
    什么都还没查到就停的，服务端全退，这边只给「重新背调」
  */
  const 查到过 = 原 ? Object.values(原.stages).some((x) => x.tools.some((t) => t.status === "done")) : false;
  const s = 原 && !原.done && job?.status === "error" && 查到过 ? { ...原, done: { charge: 0, 不完整: true } } : 原;

  if (!job) return <Confirm company={company} onCancel={onCancel} onStart={() => runStream<背调答案>(jobKey, { mode: "research", company, customerId: customer?.id }, undefined, { 名: `背调 ${company}`.slice(0, 18), 去: 任务去 })} />;
  if (!s) return job.status === "error" ? <div className="rs-err">{job.error}</div> : null;

  const 出错 = job.status === "error" ? job.error : undefined;
  return (
    <ResearchCard
      s={s}
      running={running}
      error={出错}
      起={job.startedAt}
      ms={job.value?.ms}
      actions={
        running ? (
          <div className="rs-actions">
            <button type="button" className="rs-btn" onClick={() => cancelStream(jobKey)}>
              停下（已查到的照样出报告）
            </button>
          </div>
        ) : s.done ? (
          <Done s={s} customer={customer} on记跟进={on记跟进} />
        ) : (
          <div className="rs-actions">
            <button type="button" className="rs-btn" onClick={() => clearJob(jobKey)}>
              重新背调
            </button>
          </div>
        )
      }
    />
  );
}

function Confirm({ company, onStart, onCancel }: { company: string; onStart: () => void; onCancel?: () => void }) {
  const [价, set价] = useState<价目 | null>(null);
  useEffect(() => {
    let 活 = true;
    背调价目()
      .then((r) => 活 && set价(r))
      .catch(() => 活 && set价({ 可用: false, 原因: "问不到背调服务，稍后再试" }));
    return () => {
      活 = false;
    };
  }, []);
  if (!价) return <div className="rs-confirm"><span className="rs-confirm-t">正在准备背调「{company}」…</span></div>;
  if (!价.可用)
    return (
      <div className="rs-confirm">
        <span className="rs-confirm-t">背调「{company}」：{价.原因}</span>
        {onCancel && <button type="button" className="rs-btn" onClick={onCancel}>知道了</button>}
      </div>
    );
  const 不够 = 价.还剩 != null && 价.还剩 < 价.扣次;
  return (
    <div className="rs-confirm" role="group" aria-label="背调确认">
      <span className="rs-confirm-t">
        上网背调 <b>{company}</b>：认准公司 → 基本面 → 相关性 → 近期信号 → 风险 → 切入建议。
        {价.模拟 ? "（开发环境，用模拟数据，不扣次数）" : 价.扣次 > 0 ? <> 扣 <b>{价.扣次}</b> 次 AI{价.还剩 != null && <>，你还剩 {价.还剩} 次</>}。</> : null}
        {不够 && " 次数不够了。"}
      </span>
      {onCancel && <button type="button" className="rs-btn" onClick={onCancel}>取消</button>}
      <button type="button" className="rs-btn rs-btn-primary" onClick={onStart} disabled={不够}>
        开始背调
      </button>
    </div>
  );
}

/** 跑完以后的按钮。所有写库都是人点的（AI 不自己改数据） */
function Done({ s, customer, on记跟进 }: { s: 背调状态; customer?: { id: string; name: string }; on记跟进?: () => void }) {
  const { message } = App.useApp();
  const [存到, set存到] = useState<{ id: string; name: string } | null>(null);
  const [开存, set开存] = useState(false);
  const [忙, set忙] = useState(false);

  const 复制 = async () => {
    await navigator.clipboard.writeText(报告文本(s));
    message.success("报告已复制");
  };
  const 存给 = async (c: { id: string; name: string }) => {
    set忙(true);
    const r = await 存背调到客户(c.id, s).finally(() => set忙(false));
    if (!r.ok) return void message.error(r.error);
    set存到(c);
    set开存(false);
    message.success(`已存进「${c.name}」的跟进记录`);
  };

  return (
    <>
      <div className="rs-actions">
        {存到 ? (
          <button type="button" className="rs-btn rs-btn-saved" disabled>
            ✓ 已存进「{存到.name}」
          </button>
        ) : (
          <button type="button" className="rs-btn rs-btn-primary" disabled={忙} onClick={() => (customer ? 存给(customer) : set开存((v) => !v))}>
            存进客户
          </button>
        )}
        {customer && on记跟进 ? (
          <button type="button" className="rs-btn" onClick={on记跟进}>
            记一条跟进
          </button>
        ) : 存到 ?? customer ? (
          <Link className="rs-btn" href={`/customers/${(存到 ?? customer)!.id}?do=followup`}>
            记一条跟进
          </Link>
        ) : null}
        {!customer && 存到 && (
          <Link className="rs-btn" href={`/customers/${存到.id}`}>
            打开客户
          </Link>
        )}
        <button type="button" className="rs-btn" onClick={复制}>
          复制报告
        </button>
      </div>
      {开存 && !存到 && <SavePicker s={s} onPick={存给} onCreated={(c) => { set存到(c); set开存(false); }} />}
    </>
  );
}

/**
 * 「存进客户」：先看库里有没有像的（同名、名字包含），有就让人选；没有 / 都不是就新建一位。
 * **不自己猜着合并**——挂错客户比没挂更糟。新建时把查到的国家、邮箱、电话填好，人可以改。
 */
function SavePicker({ s, onPick, onCreated }: { s: 背调状态; onPick: (c: { id: string; name: string }) => void; onCreated: (c: { id: string; name: string }) => void }) {
  const { message } = App.useApp();
  const 外贸 = useBusiness().template === "trade";
  const [像的, set像的] = useState<{ id: string; name: string }[] | null>(null);
  const [名, set名] = useState(s.目标.name);
  const [国家, set国家] = useState((s.fields.country?.value ?? "").split(/[·,，、/]/)[0].trim());
  const [邮箱, set邮箱] = useState("");
  const [电话, set电话] = useState("");
  const [忙, set忙] = useState(false);
  useEffect(() => {
    let 活 = true;
    找同名客户(s.目标.name).then((r) => 活 && set像的(r)).catch(() => 活 && set像的([]));
    认联系方式(s.fields.contact?.value).then((r) => {
      if (!活) return;
      set邮箱(r.email);
      set电话(r.phone);
    });
    return () => {
      活 = false;
    };
  }, [s.目标.name, s.fields.contact?.value]);

  const 新建 = async () => {
    set忙(true);
    const r = await 新建客户并存背调({ name: 名, country: 国家, email: 邮箱, phone: 电话 }, s).finally(() => set忙(false));
    if (!r.ok) return void message.error(r.error);
    message.success(`已新建「${名}」并存进报告`);
    onCreated({ id: r.id, name: 名 });
  };

  return (
    <div className="rs-save">
      {像的 && 像的.length > 0 && (
        <div className="rs-save-row">
          <span className="rs-save-hint">库里已经有：</span>
          {像的.map((c) => (
            <button key={c.id} type="button" className="rs-btn" onClick={() => onPick(c)}>
              存到「{c.name}」
            </button>
          ))}
        </div>
      )}
      <div className="rs-save-row">
        <input aria-label="公司名" value={名} onChange={(e) => set名(e.target.value)} placeholder="公司名" />
        <input aria-label="国家" value={国家} onChange={(e) => set国家(e.target.value)} placeholder="国家" />
      </div>
      <div className="rs-save-row">
        <input aria-label="邮箱" value={邮箱} onChange={(e) => set邮箱(e.target.value)} placeholder="邮箱" />
        <input aria-label="电话" value={电话} onChange={(e) => set电话(e.target.value)} placeholder="电话 / WhatsApp" />
        <button type="button" className="rs-btn rs-btn-primary" disabled={忙 || !名.trim()} onClick={新建}>
          新建客户并存入
        </button>
      </div>
      <span className="rs-save-hint">
        {/* 认人的规矩和新建客户表单同一条（customers/actions.ts saveCustomer）：外贸三样填一样，别的模版电话必填 */}
        {外贸 ? "电话、WhatsApp、邮箱至少填一个（CRM 靠它认人）。" : "电话必填（CRM 靠它认人）。"}报告会存成这位客户的一条跟进记录，来源链接都在。
      </span>
    </div>
  );
}
