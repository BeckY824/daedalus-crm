"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { App, Alert, Button, Input, InputNumber, Select, Space, Steps } from "antd";
import DatePicker from "@/components/BusinessDatePicker";
import { PageHead } from "@/components/ui";
import { useBusiness } from "@/lib/business-client";
import { useMe, 默认负责人 } from "@/lib/me-client";
import { 草稿全名, 读草稿, 存草稿, 清草稿, 有内容 } from "@/lib/form-guard";
import { 跟进类型们 } from "@/lib/constants";
import { 币种选项, 默认币种 } from "@/lib/currency";
import { 金额格式 } from "@/lib/money-input";
import { 成员选项, 独自一人, dayjs, type 可选成员 } from "@/lib/utils";
import { 外贸精简 } from "@/lib/business-config";
import { 项目名上限, 备注上限 } from "@/lib/project/wizard";
import { checkDuplicate, type DuplicateHit } from "../../customers/actions";
import { 查号码, type 查号码结果 } from "../../customers/number-actions";
import { 向导能选类型, 带进联系人, type 联系人三格 } from "@/lib/enterprise/contact-format";
import { 建档向导 } from "../actions";

const 草稿键 = "项目建档向导";
const 步骤们 = ["查重", "联系人", "客户", "项目", "首条沟通"] as const;
const 时间格式 = "YYYY-MM-DD HH:mm";

type 稿 = {
  /** 第一步那个号码。企业版下是选的那种号码（手机号 / 邮箱 / 微信 / 旺旺 ID），不一定是电话 */
  phone: string;
  /** 企业版第一步选的号码类型（lib/enterprise/contact-format.ts）；开关关着没有这格 */
  号码类型?: string;
  联系人: { name: string; position: string; phone: string; email: string; wechat: string };
  /** 企业版：上一次查重带进联系人那几格的值（人没动过的，再查一个号时跟着换）；开关关着没有这格 */
  带过?: Partial<联系人三格>;
  客户: { name: string; school: string; remark: string };
  项目: { name: string; ownerId: string; amount: number | null; currency: string; remark: string };
  /** 下一步时间（YYYY-MM-DD）：开了超时回收时才有这格、必填；老草稿里没有这格 */
  跟进: { type: string; content: string; occurredAt: string; 下一步时间?: string | null };
};

function 空稿(ownerId: string, currency: string, 首类型: string): 稿 {
  return {
    phone: "",
    联系人: { name: "", position: "", phone: "", email: "", wechat: "" },
    客户: { name: "", school: "", remark: "" },
    项目: { name: "", ownerId, amount: null, currency, remark: "" },
    跟进: { type: 首类型, content: "", occurredAt: dayjs().format(时间格式) },
  };
}

/** 每一步往下走之前要填好的；返回一句人话，空串 = 能走 */
/** 企业版查重认的是「类型 + 号码」：换了类型要重查 */
const 查过键 = (d: 稿, 企: boolean) => (企 ? `${d.号码类型 ?? ""}|${d.phone.trim()}` : d.phone.trim());

function 这步还差(步: number, d: 稿, 已查: string | null, 要下一步: boolean, 企: boolean): string {
  if (步 === 0 && 企) return !d.号码类型 ? "🔀请选择号码类型" : !d.phone.trim() ? "先填号码再查" : 已查 !== 查过键(d, 企) ? "点「查重」看看这个号码有没有人录过" : "";
  if (步 === 0) return !d.phone.trim() ? "先填电话再查" : 已查 !== d.phone.trim() ? "点「查重」看看这个号码有没有人录过" : "";
  if (步 === 1) return d.联系人.name.trim() ? "" : "请填写联系人姓名";
  if (步 === 2) return d.客户.name.trim() ? "" : "请填写名称";
  if (步 === 3) return !d.项目.name.trim() ? "请填写项目名称" : d.项目.name.trim().length > 项目名上限 ? `项目名称请控制在 ${项目名上限} 字以内` : "";
  if (!d.跟进.content.trim()) return "请填写这次沟通的内容";
  return 要下一步 && !d.跟进.下一步时间 ? "请填下一步时间：到那天还没跟进，项目会自动回到项目公海" : "";
}

/**
 * 建档向导（团队版项目模式 1a，2026-10-23）：查重 → 联系人 → 客户 → 项目 → 首条沟通。
 * 中途关掉不落库，填过的存在本机草稿里（一人一份），下次进来接着填；最后一步一笔建好，失败整笔不留
 */
export default function ProjectWizard({ users, 要下一步, 企业版 = false }: { users: 可选成员[]; 要下一步: boolean; 企业版?: boolean }) {
  // 草稿在本机 localStorage 里，服务端渲染时读不到；挂上之后再按草稿起头，免得两边对不上
  const 挂上了 = useSyncExternalStore(不订阅, () => true, () => false);
  const 我 = useMe();
  const 全名 = 草稿全名(我?.id, 草稿键);
  if (!挂上了) return null;
  const 旧 = 读草稿(全名) as { 稿?: 稿; 步?: number } | null;
  return <WizardBody key={全名} users={users} 要下一步={要下一步} 企业版={企业版} 全名={全名} 旧={旧?.稿 && 有内容(旧.稿) ? { 稿: 旧.稿, 步: Number(旧.步) || 0 } : null} />;
}

const 不订阅 = () => () => {};

/**
 * 要下一步 = 企业版开了超时回收：首条沟通要填下一步时间（项目建在线索阶段）。
 * 企业版 = 第一步先选号码类型、按类型验格式、全公司查重（2026-10-26，customers/number-actions.ts）；关着第一步和原来一模一样
 */
function WizardBody({ users, 要下一步, 企业版, 全名, 旧 }: { users: 可选成员[]; 要下一步: boolean; 企业版: boolean; 全名: string; 旧: { 稿: 稿; 步: number } | null }) {
  const router = useRouter();
  const { message } = App.useApp();
  const b = useBusiness();
  const 我 = useMe();
  const 能选类型 = 跟进类型们(外贸精简(b)).filter((t) => t.value !== "TASK" && t.value !== "REMIND");
  // 不在候选里的「我」（老板、管理员不做销售）默认还是记在我名下（服务端也这么填）：下拉里补上我自己，不然那一格露出内部编号
  const 负责人选项 = 我 && !users.some((u) => u.id === 我.id) ? [...成员选项(users), { value: 我.id, label: 我.name }] : 成员选项(users);
  const 新稿 = (): 稿 => {
    const n = 空稿(默认负责人(我, users) ?? 我?.id ?? "", b.currency || 默认币种, 能选类型[0]?.value ?? "PHONE");
    // 企业版号码类型默认手机号（最常见）；关着不带这一格，草稿和原来一样
    return 企业版 ? { ...n, 号码类型: "手机号" } : n;
  };

  // 上次没填完的接着填
  const [步, set步] = useState(() => (旧 ? Math.min(Math.max(0, 旧.步), 步骤们.length - 1) : 0));
  const [d, setD] = useState<稿>(() => (旧 ? { ...新稿(), ...旧.稿 } : 新稿()));
  // 走过第一步的草稿，号码当已经查过（当时没撞）；这期间被别人录了，最后一步 saveCustomer 还会再拦一次
  const [已查, set已查] = useState<string | null>(() => (旧 && 旧.步 > 0 && 旧.稿.phone ? 查过键(旧.稿, 企业版) : null));
  const [撞, set撞] = useState<DuplicateHit>(null);
  // 企业版「查重」回来的那句（格式不对 / 首次录入 / 撞了哪种）
  const [企查, set企查] = useState<查号码结果 | null>(null);
  const [查中, set查中] = useState(false);
  const [交中, set交中] = useState(false);
  const [接着填, set接着填] = useState(!!旧);

  const 改 = <K extends keyof 稿>(k: K, v: Partial<稿[K]> | 稿[K]) => {
    setD((o) => {
      const n = { ...o, [k]: typeof v === "object" && v !== null ? { ...(o[k] as object), ...v } : v } as 稿;
      存草稿(全名, { 稿: n, 步 });
      return n;
    });
  };
  const 去 = (n: number) => {
    set步(n);
    存草稿(全名, { 稿: d, 步: n });
  };

  const 查重 = async () => {
    const 号 = d.phone.trim();
    if (!号) return;
    set查中(true);
    try {
      if (企业版) {
        if (!d.号码类型) return;
        const r = await 查号码(d.号码类型, 号);
        set企查(r);
        set已查(查过键(d, true));
        if (r.ok && r.状态 === "首次录入") {
          // 查过的号码顺手填进联系人那一格：空着的、或者还是上次查重带进去的（人没改过）换成这次的
          const 类型 = d.号码类型;
          setD((o) => {
            const t = 带进联系人(o.联系人, o.带过, 类型, r.值);
            const n = { ...o, 联系人: { ...o.联系人, ...t.改 }, 带过: t.带过 };
            存草稿(全名, { 稿: n, 步 });
            return n;
          });
        }
        return;
      }
      const hit = await checkDuplicate(号);
      set撞(hit);
      set已查(号);
      if (!hit && !d.联系人.phone) 改("联系人", { phone: 号 });
    } catch {
      message.error("查重没查成，请稍后再试");
    } finally {
      set查中(false);
    }
  };

  const 差 = 这步还差(步, d, 已查, 要下一步, 企业版);
  const 企拦 = 企业版 && !!企查 && 已查 === 查过键(d, true) && !(企查.ok && 企查.状态 === "首次录入");
  const 拦着 = 步 === 0 && (!!撞 || 企拦);

  const 提交 = async () => {
    set交中(true);
    try {
      const r = await 建档向导({
        客户: {
          // 企业版：选的不是手机号的，电话空着，号码按 企业号码 交（saveCustomer 按类型存、再查一次重）
          name: d.客户.name, phone: 企业版 && d.号码类型 !== "手机号" ? "" : d.phone,
          ...(企业版 ? { 企业号码: { 类型: d.号码类型 ?? "", 值: d.phone } } : {}),
          school: d.客户.school || null, grade: null, major: null,
          followStatus: "待跟进", decisionStatus: "了解中", expectedSignAt: null, remark: d.客户.remark || null,
          // 客户也记在项目负责人名下：负责人打开项目时得看得到这位客户
          salesOwnerId: d.项目.ownerId || null, channelId: null, referrerCustomerId: null,
        },
        联系人: d.联系人,
        项目: { ...d.项目, amount: d.项目.amount ?? 0, ownerId: d.项目.ownerId || null },
        跟进: d.跟进,
      });
      if (!r.ok) {
        message.error(r.error);
        return;
      }
      清草稿(全名);
      message.success(`已建好项目「${d.项目.name.trim()}」`);
      router.push(`/projects/${r.projectId}`);
    } catch {
      message.error("没建成，请稍后再试；填过的还在");
    } finally {
      set交中(false);
    }
  };

  const 重来 = () => {
    清草稿(全名);
    setD(新稿());
    set步(0);
    set已查(null);
    set撞(null);
    set企查(null);
    set接着填(false);
  };

  const 一行 = (label: string, el: React.ReactNode, 必填 = false) => (
    <label className="wiz-row" style={{ display: "block", marginBottom: 16 }}>
      <div style={{ marginBottom: 6, color: "var(--text-muted)" }}>{必填 && <span style={{ color: "var(--danger)" }}>* </span>}{label}</div>
      {el}
    </label>
  );

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHead title="新建项目" subtitle={`一次建好${b.customer}、联系人、项目和第一次沟通；中途离开会存成草稿`} />
      {接着填 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="接着上次没填完的"
          action={<Button size="small" onClick={重来}>清空重来</Button>}
        />
      )}
      <Steps current={步} size="small" style={{ marginBottom: 24 }} items={步骤们.map((t) => ({ title: t }))} />

      {步 === 0 && 企业版 && (
        <>
          {一行("联系方式", (
            <Space.Compact style={{ width: "100%" }}>
              <Select
                style={{ width: 130 }}
                placeholder="号码类型"
                value={d.号码类型}
                options={向导能选类型.map((t) => ({ value: t, label: t === "旺旺ID" ? "旺旺 ID" : t }))}
                onChange={(v) => {
                  改("号码类型", v);
                  set企查(null);
                }}
              />
              <Input
                value={d.phone}
                placeholder="先查一下这个号码有没有人录过"
                onChange={(e) => {
                  改("phone", e.target.value);
                  set企查(null);
                }}
                onPressEnter={() => void 查重()}
              />
              <Button loading={查中} disabled={!d.号码类型} onClick={() => void 查重()}>查重</Button>
            </Space.Compact>
          ), true)}
          {企查 && 已查 === 查过键(d, true) && (
            企查.ok && 企查.状态 === "首次录入" ? <Alert type="success" showIcon title={企查.提示} description={企查.归属地 ? `归属地：${企查.归属地}` : undefined} />
            : !企查.ok ? <Alert type="warning" showIcon title={企查.提示} />
            : (
              <Alert
                type="error"
                showIcon
                title={企查.提示}
                description={企查.撞?.id || 企查.归属地 ? (
                  <span>
                    {企查.撞?.id && <><Link href={`/customers/${企查.撞.id}`}>{企查.撞.name}</Link>{企查.撞.school ? ` · ${企查.撞.school}` : ""} · 在 {企查.撞.salesOwnerName} 名下</>}
                    {企查.撞?.id && 企查.归属地 ? " · " : ""}
                    {企查.归属地 ? `归属地：${企查.归属地}` : ""}
                  </span>
                ) : undefined}
              />
            )
          )}
        </>
      )}

      {步 === 0 && !企业版 && (
        <>
          {一行(`${b.customer}电话`, (
            <Space.Compact style={{ width: "100%" }}>
              <Input
                value={d.phone}
                placeholder="先查一下这个号码有没有人录过"
                onChange={(e) => {
                  改("phone", e.target.value);
                  set撞(null);
                }}
                onPressEnter={() => void 查重()}
              />
              <Button loading={查中} onClick={() => void 查重()}>查重</Button>
            </Space.Compact>
          ), true)}
          {撞 && (
            <Alert
              type="error"
              showIcon
              title={`已有${b.customer}用这个号码，不能重复建档`}
              description={
                撞.id ? (
                  <span>
                    <Link href={`/customers/${撞.id}`}>{撞.name}</Link>
                    {撞.school ? ` · ${撞.school}` : ""} · 在 {撞.salesOwnerName} 名下。要给这位{b.customer}开新项目，请找 {撞.salesOwnerName} 或老板
                  </span>
                ) : (
                  <span>同事 {撞.salesOwnerName} 名下已经有这个号码{撞.name ? `（${撞.name}）` : ""}；要接手请找 {撞.salesOwnerName} 或老板</span>
                )
              }
            />
          )}
          {!撞 && 已查 === d.phone.trim() && d.phone.trim() && <Alert type="success" showIcon title="没人录过这个号码，可以往下走" />}
        </>
      )}

      {步 === 1 && (
        <>
          {一行("联系人姓名", <Input value={d.联系人.name} onChange={(e) => 改("联系人", { name: e.target.value })} />, true)}
          {一行("职位", <Input value={d.联系人.position} onChange={(e) => 改("联系人", { position: e.target.value })} />)}
          {一行("联系人电话", <Input value={d.联系人.phone} onChange={(e) => 改("联系人", { phone: e.target.value })} />)}
          {一行("邮箱", <Input value={d.联系人.email} onChange={(e) => 改("联系人", { email: e.target.value })} />)}
          {一行("微信", <Input value={d.联系人.wechat} onChange={(e) => 改("联系人", { wechat: e.target.value })} />)}
        </>
      )}

      {步 === 2 && (
        <>
          {一行(`${b.customer}名称`, <Input value={d.客户.name} onChange={(e) => 改("客户", { name: e.target.value })} />, true)}
          {一行(b.fields.school, <Input value={d.客户.school} onChange={(e) => 改("客户", { school: e.target.value })} />)}
          {一行("备注", <Input.TextArea rows={3} value={d.客户.remark} onChange={(e) => 改("客户", { remark: e.target.value })} />)}
        </>
      )}

      {步 === 3 && (
        <>
          {一行("项目名称", <Input value={d.项目.name} maxLength={项目名上限} showCount onChange={(e) => 改("项目", { name: e.target.value })} />, true)}
          {!独自一人(users, d.项目.ownerId) && 一行("负责人", (
            <Select style={{ width: "100%" }} value={d.项目.ownerId || undefined} options={负责人选项} onChange={(v) => 改("项目", { ownerId: v })} />
          ))}
          {一行("金额", (
            <Space.Compact style={{ width: "100%" }}>
              <Select style={{ width: 140 }} value={d.项目.currency} options={币种选项()} onChange={(v) => 改("项目", { currency: v })} showSearch optionFilterProp="label" />
              <InputNumber<number>
                style={{ width: "100%" }}
                min={0}
                value={d.项目.amount}
                formatter={金额格式}
                onChange={(v) => 改("项目", { amount: v })}
              />
            </Space.Compact>
          ))}
          {一行("备注", <Input.TextArea rows={3} maxLength={备注上限} value={d.项目.remark} onChange={(e) => 改("项目", { remark: e.target.value })} />)}
        </>
      )}

      {步 === 4 && (
        <>
          {一行("沟通方式", (
            <Select style={{ width: "100%" }} value={d.跟进.type} options={能选类型.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => 改("跟进", { type: v })} />
          ), true)}
          {一行("时间", (
            <DatePicker
              showTime={{ format: "HH:mm" }}
              format={时间格式}
              allowClear={false}
              style={{ width: "100%" }}
              value={dayjs(d.跟进.occurredAt, 时间格式)}
              disabledDate={(x) => x.isAfter(dayjs(), "day")}
              onChange={(v) => v && 改("跟进", { occurredAt: v.format(时间格式) })}
            />
          ), true)}
          {一行("沟通内容", <Input.TextArea rows={4} value={d.跟进.content} onChange={(e) => 改("跟进", { content: e.target.value })} />, true)}
          {要下一步 && 一行("下一步时间", (
            <>
              <DatePicker
                style={{ width: "100%" }}
                value={d.跟进.下一步时间 ? dayjs(d.跟进.下一步时间) : null}
                disabledDate={(x) => x.isBefore(dayjs(), "day")}
                onChange={(v) => 改("跟进", { 下一步时间: v ? v.format("YYYY-MM-DD") : null })}
                placeholder="选一天"
              />
              <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>到那天还没人跟进，项目会自动回到项目公海</div>
            </>
          ), true)}
        </>
      )}

      <Space style={{ marginTop: 8 }}>
        {步 > 0 && <Button onClick={() => 去(步 - 1)}>上一步</Button>}
        {步 < 步骤们.length - 1 ? (
          <Button type="primary" disabled={!!差 || 拦着} title={差 || undefined} onClick={() => 去(步 + 1)}>下一步</Button>
        ) : (
          <Button type="primary" disabled={!!差} title={差 || undefined} loading={交中} onClick={() => void 提交()}>建好项目</Button>
        )}
        <Button type="text" onClick={() => router.push("/projects")}>先不建了</Button>
      </Space>
      {差 && !拦着 && <div style={{ marginTop: 8, color: "var(--text-muted)" }}>{差}</div>}
    </div>
  );
}
