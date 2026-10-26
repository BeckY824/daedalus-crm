"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { App, Alert, Button, Card, Checkbox, Input, Modal, Popconfirm, Progress, Select, Space, Tag, Timeline, Tooltip } from "antd";
import DatePicker from "@/components/BusinessDatePicker";
import { 必填叫法 } from "@/lib/project/required";
import { PageHead, CustomerLink, FollowTypeCell } from "@/components/ui";
import { useBusiness } from "@/lib/business-client";
import { dayjs, fmtDateTime } from "@/lib/utils";
import { 跟进类型们 } from "@/lib/constants";
import { 外贸精简 } from "@/lib/business-config";
import { 金额 } from "@/lib/currency";
import { 阶段们, 节点们, 出口们, 交付还差, 下一步, 节点序号, 节点总数, 原因上限, 要写原因, type 位置 } from "@/lib/project/nodes";
import { 超时理由 } from "@/lib/project/timeout";
import { 改项目节点, 勾项目交付, 删除项目, 放回项目公海, 领取项目, 记项目沟通Action } from "../actions";
import type { 可选成员 } from "@/lib/utils";
import { ProjectEditModal, ProjectTeamCard, type 组员, type 角色, type 联系人 } from "./ProjectTeam";

export type 项目详情 = {
  id: string; name: string; remark: string | null; amount: number; currency: string;
  /** null = 公海里同事客户的项目，领取后再给（page.tsx 露客户）；联系人、沟通这时也是空的 */
  customer: { id: string; name: string; school: string | null } | null;
  contact: { id: string; name: string; position: string | null } | null;
  ownerId: string; ownerName: string; creatorName: string; createdAt: string;
  /** 历史负责人（只企业版有，别的版本是空的）：把这个项目放回过公海的人，最近放回的在前，同一个人只列一次 */
  historyOwners: string[];
  phase: string; node: string; result: string | null;
  /** 异常状态时：选的异常类别名、备注（可空） */
  exceptionReason: string | null; exceptionCategory: string | null;
  /** 在项目公海里；能放公海 = 我是负责人且在线索 / 商机阶段；能领取 = 在公海里，且我不是原负责人（企业版按 pool-rules.ts） */
  pooled: boolean; 能放公海: boolean; 能领取: boolean;
  /** 企业版原负责人领不回时那句话：领取按钮照样摆、灰着，悬停给这句；null = 不用灰 */
  领取不给: string | null;
  /** 在公海里时最近一次怎么进来的（ownerName 这时是原负责人）：谁放的、超时系统收 / 办停用时放 / 手动放回 */
  进公海: { 方式: 放回方式; 谁: string } | null;
  /** 服务端读的 企业版()：放回公海的说法跟着它走 */
  企业版: boolean;
  /**
   * 企业版超时回收：nextStepAt 是最近一次沟通填的下一步时间（服务端排好的 YYYY-MM-DD）；回收日 = 哪天没人跟进就自动回公海（null = 不会）；
   * 要下一步 = 记沟通必须填下一步时间；能记沟通 = 企业版里的负责人、老板、主管、项目组成员，且不在公海（不是企业版照原来去客户页记）
   */
  nextStepAt: string | null; 回收日: string | null; 要下一步: boolean; 能记沟通: boolean;
  /**
   * 企业版节点必填：这个节点配了必填才有（没开 / 没配 / 有结局 / 在公海 = null）。填齐了自动往前推；
   * 只能靠填齐 = 不是老板、主管，手动往前推不给（往后退、点结局照旧）
   */
  必填: { 配了: string[]; 还差: string[]; 只能靠填齐: boolean } | null;
  /** 企业版 D-37：负责人有直属上级、我又不是这位上级（也不是老板）时，往前推不给的那句话；null = 能推 */
  不给推: string | null;
  /** 能改节点：能改的人 + 企业版负责人的直属上级（账号可能是 SALES）；只管节点这一块 */
  能改节点: boolean;
  balanceSettled: boolean; balanceSettledBy: string | null; balanceSettledAt: string | null;
  acceptancePassed: boolean; acceptancePassedBy: string | null; acceptancePassedAt: string | null;
  /** kind 不是 node 的行是换负责人（转让 / 放回公海 / 从公海领取），transfer 记从谁到谁；category 是进异常时选的类别 */
  logs: {
    id: string; at: string; who: string; from: 位置 | null; to: 位置; reason: string | null; category: string | null;
    kind: "node" | "transfer" | "pool-release" | "pool-claim"; transfer: { from: string; to: string } | null;
    /** pool-release 才有：超时系统收的、办停用时放的（who 是办的那位）、手动放回 */
    放回方式?: 放回方式;
  }[];
  followUps: { id: string; type: string; content: string; occurredAt: string; who: string; node: string }[];
  members: 组员[];
  /** 删项目时一起删掉的：节点留痕（含转让痕）、项目组、沟通和项目的关联 */
  删前清点: { 留痕: number; 组员: number; 沟通: number };
};

const 行样: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", marginBottom: 8, minWidth: 0 };
const 键样: React.CSSProperties = { color: "var(--text-muted)", flex: "0 0 48px" };

/** 删项目的确认框：列出一起删掉的几样，说清沟通记录本身不删 */
function 删除说明(n: 项目详情["删前清点"], 客户叫法: string) {
  const 删 = [`${n.留痕} 条节点留痕`, n.组员 ? `项目组 ${n.组员} 人` : "", n.沟通 ? `${n.沟通} 条沟通和这个项目的关联` : ""].filter(Boolean);
  return (
    <div style={{ maxWidth: 280 }}>
      <div>一起删掉：{删.join("、")}</div>
      <div>沟通记录本身留在{客户叫法}下，不删。删了找不回来</div>
    </div>
  );
}

/** 「线索·潜客培育」「订单·验收交付（异常状态）」 */
function 位置文字(p: 位置): string {
  return `${p.phase}·${p.node}${p.result ? `（${p.result}）` : ""}`;
}

/**
 * 下拉里的去处：每个阶段的节点，加上这个阶段的「没走成」结局（订单阶段是成功交付和异常状态）。
 * 异常状态只在项目已经在订单阶段时出现，线索、商机阶段不给这个入口。
 * 往前只能一步（比现在多走超过一步的灰着），往后随便退——和 lib/project/nodes.ts 改节点问题 同一条规矩
 */
function 去处们(当前: 位置, 不能往前 = false) {
  // 配了必填、不是老板主管：往前的节点灰着（靠填齐自动推），结局照旧能点
  const 太远 = (到: 位置) => 节点序号(到) > 节点序号(当前) + (不能往前 && !到.result ? 0 : 1);
  return 阶段们.map((s) => {
    const 尾 = 节点们[s][节点们[s].length - 1];
    const 结局 = s === "订单" ? 出口们.订单.filter((r) => r !== "异常状态" || 当前.phase === "订单") : [出口们[s][1]];
    return {
      label: s,
      options: [
        ...节点们[s].map((n) => {
          const 到 = { phase: s, node: n };
          return { value: JSON.stringify(到), label: n, disabled: (!当前.result && 当前.phase === s && 当前.node === n) || 太远(到) };
        }),
        // 结局落在哪个节点：没走成的停在当前节点（同阶段时），否则停在阶段最后一个节点
        ...结局.map((r) => {
          const 到 = { phase: s, node: 当前.phase === s ? 当前.node : 尾, result: r };
          return { value: JSON.stringify(到), label: `→ ${r}`, disabled: 当前.result === r || 太远(到) };
        }),
      ],
    };
  });
}

/** 项目怎么进的公海（page.tsx 按理由分）：超时 = 系统收的；停用 = 管理员办停用时放的；手动 = 有人放回 */
export type 放回方式 = "超时" | "停用" | "手动";

/** 节点变更里换负责人那几种行怎么说。放回公海按真正的操作人说（QA #14：超时是系统、停用是办的那位管理员，不是原负责人） */
function 换人文字(l: 项目详情["logs"][number]): string {
  const t = l.transfer ?? { from: "没人", to: "没人" };
  if (l.kind === "pool-release") {
    // 老数据没带方式的按理由认超时
    const 方式 = l.放回方式 ?? (l.reason === 超时理由 ? "超时" : "手动");
    if (方式 === "超时") return `${t.from} 的项目超时没跟进，系统自动收回到项目公海`;
    if (方式 === "停用") return `${l.who} 办成员停用，把 ${t.from} 的项目放回项目公海`;
    return l.who === t.from ? `${t.from} 把项目放回项目公海` : `${l.who} 把 ${t.from} 的项目放回项目公海`;
  }
  if (l.kind === "pool-claim") return `${t.to} 从项目公海领取，成为负责人`;
  return `负责人从 ${t.from} 转给 ${t.to}`;
}

/** 负责人那一行括号里：怎么进的公海 */
function 进公海说法(进: 项目详情["进公海"], 原负责人: string): string {
  if (!进) return "";
  if (进.方式 === "超时") return " · 超时没跟进，系统自动收回";
  if (进.方式 === "停用") return ` · 成员停用，${进.谁} 放回`;
  return 进.谁 === 原负责人 ? " · 自己放回的" : ` · ${进.谁} 放回的`;
}

/**
 * 项目详情：顶上是节点进度和「下一步」，中间改节点 / 点结局、勾尾款结清和验收通过，下面是节点变更和挂在这个项目上的沟通。
 * 只有负责人、老板、主管能改；其他人看得到、按钮灰着
 */
export default function ProjectDetail({
  p, 能改, 候选, 在职, 联系人们, 角色们, 类别们,
}: {
  p: 项目详情;
  能改: boolean;
  候选: 可选成员[];
  在职: 可选成员[];
  联系人们: 联系人[];
  角色们: 角色[];
  /** 在用的异常类别（进异常状态时选） */
  类别们: { id: string; name: string }[];
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const b = useBusiness();
  const [忙, set忙] = useState(false);
  const [异常框, set异常框] = useState<位置 | null>(null);
  const [没成框, set没成框] = useState<位置 | null>(null);
  const [原因, set原因] = useState("");
  const [类别, set类别] = useState<string | null>(null);
  const [编辑开着, set编辑开着] = useState(false);
  const [记一条开着, set记一条开着] = useState(false);
  const 当前: 位置 = { phase: p.phase, node: p.node, result: p.result };
  const 下 = 下一步(当前);
  const 差 = 交付还差(p);
  const 异常 = p.result === "异常状态";
  const 可改 = 能改 && !p.pooled;
  const 不能改 = p.pooled ? "这个项目在项目公海里，领取了才能改" : 能改 ? undefined : "只有项目负责人、老板或主管能改";
  const 节点可改 = p.能改节点 && !p.pooled;
  const 节点不能改 = p.能改节点 ? (p.pooled ? 不能改 : undefined) : 不能改;

  const 跑 = async (f: () => Promise<{ ok: boolean; error?: string; 自动推到?: string[] }>, 成了?: string) => {
    set忙(true);
    try {
      const r = await f();
      if (!r.ok) message.error(r.error ?? "没改成，请稍后再试");
      else {
        if (成了) message.success(成了);
        // 企业版节点必填：这次保存把必填填齐了，项目自动往前推了几步
        if (r.自动推到?.length) message.success(`必填齐了，自动推进到 ${r.自动推到.join(" → ")}`);
        router.refresh();
      }
      return r.ok;
    } catch {
      message.error("没改成，请稍后再试");
      return false;
    } finally {
      set忙(false);
    }
  };

  const 改到 = (到: 位置) => {
    if (到.result === "异常状态") {
      set原因("");
      set类别(null);
      set异常框(到);
      return;
    }
    if (p.企业版 && 要写原因(到.result)) {
      set原因("");
      set没成框(到);
      return;
    }
    if (到.result === "成功交付" && 差.length) {
      message.warning(`还差${差.join("、")}，勾上才能点成功交付`);
      return;
    }
    void 跑(() => 改项目节点(p.id, 到), `已改到 ${位置文字(到)}`);
  };

  const 删 = async () => {
    set忙(true);
    try {
      const r = await 删除项目(p.id);
      if (!r.ok) message.error(r.error);
      else {
        message.success("已删除项目，沟通记录还留在客户下");
        router.push("/projects");
      }
    } finally {
      set忙(false);
    }
  };

  return (
    <div style={{ maxWidth: 960 }}>
      <PageHead
        title={p.name}
        subtitle={`${p.pooled ? `在项目公海里 · 原负责人 ${p.ownerName}` : `负责人 ${p.ownerName}`} · ${p.creatorName} 建于 ${fmtDateTime(p.createdAt)}`}
        extra={
          <Space wrap>
            {p.能放公海 && (
              <Popconfirm title="放回项目公海？" description={p.企业版 ? "放回去以后同事都能领，你作为原负责人不能再领回来；你会记成这个项目的历史负责人" : "放回去以后谁都能领，你自己不能再领回来"} okText="放回公海" onConfirm={() => void 跑(() => 放回项目公海(p.id), "已放回项目公海")}>
                <Button disabled={忙}>放回公海</Button>
              </Popconfirm>
            )}
            {p.能领取 && <Button type="primary" disabled={忙} onClick={() => void 跑(() => 领取项目(p.id), "已领取，你是这个项目的负责人了")}>领取</Button>}
            {/* 企业版原负责人：按钮摆着、灰着，悬停说为什么（接口也拦，lib/project/db.ts 领取公海项目） */}
            {!p.能领取 && p.领取不给 && <Tooltip title={p.领取不给}><Button type="primary" disabled>领取</Button></Tooltip>}
            {能改 && (
              <Popconfirm title="删除这个项目？" description={删除说明(p.删前清点, b.customer)} okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void 删()}>
                <Button danger disabled={忙}>删除项目</Button>
              </Popconfirm>
            )}
          </Space>
        }
      />

      {p.pooled && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} title="这个项目在项目公海里" description={p.能领取 ? "领取了你就是负责人，可以接着推节点" : p.领取不给 ? `你是原负责人，${p.领取不给}，等同事领取` : "是你放回去的，等同事领取"} />
      )}

      {异常 && (
        <Alert
          type="error" showIcon style={{ marginBottom: 16 }}
          title={`这个项目在异常状态${p.exceptionCategory ? `：${p.exceptionCategory}` : ""}`}
          description={p.exceptionReason ? <span style={{ whiteSpace: "pre-wrap" }}>{p.exceptionReason}</span> : undefined}
        />
      )}

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>现在在</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              {p.phase} · {p.node}
              {p.result && <Tag style={{ marginLeft: 8 }} color={异常 ? "error" : p.result === "成功交付" ? "success" : "default"}>{p.result}</Tag>}
            </div>
          </div>
          <Space wrap>
            <Select
              style={{ width: 200 }}
              placeholder={异常 ? "改到某个节点就算恢复" : "改到…"}
              value={null}
              disabled={!节点可改 || 忙}
              title={节点不能改}
              options={去处们(当前, !!p.必填?.只能靠填齐 || !!p.不给推)}
              onChange={(v: string | null) => v && 改到(JSON.parse(v) as 位置)}
            />
            {/* 灰掉的按钮收不到鼠标事件，外面包一层 span 才能悬停出原因 */}
            <Tooltip title={节点不能改 ?? p.不给推 ?? (p.必填?.只能靠填齐 ? "这个节点填齐必填后自动往前推；要先推请找老板或主管" : 下 ? undefined : p.result ? "先改回某个节点再往前推" : "这是最后一个节点了，接下来点结局")}>
              <span>
                <Button type="primary" disabled={!节点可改 || 忙 || !下 || !!p.必填?.只能靠填齐 || !!p.不给推} onClick={() => 下 && 改到(下)}>
                  {下 ? `下一步：${下.phase === p.phase ? 下.node : `${下.phase}·${下.node}`}` : "下一步"}
                </Button>
              </span>
            </Tooltip>
          </Space>
        </div>
        <Progress
          style={{ marginTop: 12, marginBottom: 0 }}
          percent={Math.round(((p.result === "成功交付" ? 节点总数 : 节点序号(当前)) / 节点总数) * 100)}
          showInfo={false}
          status={异常 ? "exception" : p.result === "成功交付" ? "success" : "active"}
          aria-label={`第 ${节点序号(当前) + 1} 个节点，共 ${节点总数} 个`}
        />
        {p.必填 && (
          <div style={{ marginTop: 12, color: p.必填.还差.length ? "var(--text-muted)" : "var(--success-text)", overflowWrap: "anywhere" }}>
            {p.必填.还差.length
              ? `这个节点填齐必填后自动往前推，还差：${p.必填.还差.map(必填叫法).join("、")}`
              : "这个节点的必填都齐了"}
          </div>
        )}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 16 }}>
        <Card title="项目" extra={可改 && <Button type="link" size="small" disabled={忙} onClick={() => set编辑开着(true)}>编辑</Button>}>
          <div style={行样}><span style={键样}>{b.customer}</span>{p.customer ? <CustomerLink id={p.customer.id} name={p.customer.name} company={p.customer.school} /> : <span style={{ color: "var(--text-muted)" }}>领取后显示</span>}</div>
          {p.contact && <div style={行样}><span style={键样}>联系人</span>{p.contact.name}{p.contact.position ? ` · ${p.contact.position}` : ""}</div>}
          <div style={行样}><span style={键样}>金额</span>{金额(p.amount, p.currency)}</div>
          {/* 在公海里时 ownerName 是原负责人：不写成「负责人 X」，也不把系统收回说成 X 放回的（QA #14） */}
          <div style={行样}><span style={键样}>负责人</span>{p.pooled ? <span>在公海里<span style={{ color: "var(--text-muted)" }}>（原负责人 {p.ownerName}{进公海说法(p.进公海, p.ownerName)}）</span></span> : p.ownerName}</div>
          {p.historyOwners.length > 0 && (
            <div style={行样}><span style={键样}>历史</span><span style={{ minWidth: 0, overflowWrap: "anywhere" }} title="历史负责人：把这个项目放回过公海的人">{p.historyOwners.join("、")}</span></div>
          )}
          {p.nextStepAt && !p.pooled && <div style={行样}><span style={键样}>下一步</span>{p.nextStepAt}</div>}
          {p.回收日 && <div style={{ ...行样, color: 回收临近(p.回收日) ? "var(--warning-text)" : "var(--text-muted)" }}>{p.回收日} 前没人跟进，会自动回到项目公海</div>}
          {p.remark && <div style={{ marginTop: 8, whiteSpace: "pre-wrap", color: "var(--text-muted)" }}>{p.remark}</div>}
        </Card>
        <Card title="交付">
          {(["balanceSettled", "acceptancePassed"] as const).map((k) => {
            const 勾了 = p[k];
            const 谁 = k === "balanceSettled" ? p.balanceSettledBy : p.acceptancePassedBy;
            const 何时 = k === "balanceSettled" ? p.balanceSettledAt : p.acceptancePassedAt;
            return (
              <div key={k} style={{ marginBottom: 8 }}>
                <Checkbox
                  checked={勾了}
                  disabled={!可改 || 忙 || (勾了 && p.result === "成功交付")}
                  title={不能改 ?? (勾了 && p.result === "成功交付" ? "已经成功交付了；要取消先把节点改回去" : undefined)}
                  onChange={(e) => void 跑(() => 勾项目交付(p.id, k, e.target.checked))}
                >
                  {k === "balanceSettled" ? "尾款结清" : "验收通过"}
                </Checkbox>
                {勾了 && 谁 && <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>{谁} · {fmtDateTime(何时)}</span>}
              </div>
            );
          })}
          <div style={{ color: "var(--text-muted)", marginTop: 4 }}>
            {p.result === "成功交付" ? "已经成功交付" : 差.length ? `两项都勾上才能点成功交付（还差${差.join("、")}）` : "两项都勾上了，可以点成功交付"}
          </div>
          {p.result !== "成功交付" && (
            <Button
              style={{ marginTop: 8 }}
              disabled={!可改 || 忙 || 差.length > 0}
              title={不能改 ?? (差.length ? `还差${差.join("、")}` : undefined)}
              onClick={() => 改到({ phase: "订单", node: p.phase === "订单" ? p.node : 节点们.订单[节点们.订单.length - 1], result: "成功交付" })}
            >
              成功交付
            </Button>
          )}
        </Card>
      </div>

      <div style={{ marginBottom: 16 }}>
        <ProjectTeamCard projectId={p.id} 组员们={p.members} 角色们={角色们} 在职={在职} 能改={可改} 忙={忙} 跑={跑} 企业版={p.企业版} 组长={p.ownerName} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Card title="节点变更">
          <Timeline
            items={p.logs.map((l) => ({
              color: l.kind !== "node" ? "gray" : l.to.result === "异常状态" ? "red" : l.to.result === "成功交付" ? "green" : "blue",
              content: (
                <div>
                  <div>{l.kind !== "node" ? 换人文字(l) : l.from ? `${位置文字(l.from)} → ${位置文字(l.to)}` : `建档，落在 ${位置文字(l.to)}`}</div>
                  {l.category && <div style={{ color: "var(--danger-text)" }}>异常类别：{l.category}</div>}
                  {l.reason && l.reason !== 超时理由 && <div style={{ color: "var(--danger-text)", whiteSpace: "pre-wrap" }}>{l.category ? "备注" : "原因"}：{l.reason}</div>}
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{l.reason === 超时理由 ? "系统" : l.who} · {fmtDateTime(l.at)}</div>
                </div>
              ),
            }))}
          />
        </Card>
        <Card
          title="沟通"
          extra={p.能记沟通 ? <Button type="link" size="small" disabled={忙} onClick={() => set记一条开着(true)}>记一条</Button> : p.customer && <Link href={`/customers/${p.customer.id}`}>去{b.customer}页{p.企业版 ? "看看" : "记一条"}</Link>}
        >
          {p.followUps.length === 0 && <div style={{ color: "var(--text-muted)" }}>{p.customer ? "还没有挂在这个项目上的沟通" : "领取后显示"}</div>}
          {p.followUps.map((f) => (
            <div key={f.id} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <FollowTypeCell type={f.type} />
                <Tag>{f.node}</Tag>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{f.who} · {fmtDateTime(f.occurredAt)}</span>
              </div>
              <div style={{ whiteSpace: "pre-wrap", marginTop: 4, overflowWrap: "anywhere" }}>{f.content}</div>
            </div>
          ))}
        </Card>
      </div>

      {可改 && 编辑开着 && (
        <ProjectEditModal
          open
          onClose={() => set编辑开着(false)}
          跑={跑}
          p={{ id: p.id, name: p.name, ownerId: p.ownerId, amount: p.amount, currency: p.currency, remark: p.remark, contactId: p.contact?.id ?? null }}
          候选={候选}
          联系人们={联系人们}
        />
      )}

      {p.能记沟通 && 记一条开着 && <RecordFollowModal p={p} 外贸={外贸精简(b)} onClose={() => set记一条开着(false)} 跑={跑} />}

      <Modal
        open={!!异常框}
        title="进异常状态"
        okText="确定"
        okButtonProps={{ danger: true, disabled: !类别, loading: 忙 }}
        onCancel={() => set异常框(null)}
        onOk={async () => {
          if (!异常框 || !类别) return;
          const ok = await 跑(() => 改项目节点(p.id, 异常框, { categoryId: 类别, 备注: 原因 }), "已标成异常状态");
          if (ok) set异常框(null);
        }}
      >
        <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>选一个异常类别，看板上这张卡会标红；处理好了把节点改回去就算恢复，类别和备注留在节点变更里。</div>
        <Select
          style={{ width: "100%", marginBottom: 12 }}
          placeholder={类别们.length ? "选异常类别" : "没有在用的异常类别，请老板在设置里加"}
          value={类别}
          onChange={(v: string) => set类别(v)}
          options={类别们.map((c) => ({ value: c.id, label: c.name }))}
          aria-label="异常类别"
        />
        <Input.TextArea rows={4} maxLength={原因上限} showCount value={原因} onChange={(e) => set原因(e.target.value)} placeholder="备注（可不写）" />
      </Modal>

      <Modal
        open={!!没成框}
        title={没成框 ? `定结果：${没成框.result}` : ""}
        okText="确定"
        okButtonProps={{ danger: true, disabled: !原因.trim(), loading: 忙 }}
        onCancel={() => set没成框(null)}
        onOk={async () => {
          if (!没成框 || !原因.trim()) return;
          const ok = await 跑(() => 改项目节点(p.id, 没成框, { 备注: 原因 }), `已改到 ${位置文字(没成框)}`);
          if (ok) set没成框(null);
        }}
      >
        <div style={{ marginBottom: 8, color: "var(--text-muted)" }}>写一句为什么没成，会记在节点变更里；以后捡回来把节点改回去就行。</div>
        <Input.TextArea rows={4} maxLength={原因上限} showCount value={原因} onChange={(e) => set原因(e.target.value)} placeholder="原因（必填）" aria-label="原因" />
      </Modal>
    </div>
  );
}

/** 回收日在两天内（含已到）：提示变成警示色 */
function 回收临近(回收日: string): boolean {
  return dayjs(回收日).diff(dayjs().startOf("day"), "day") <= 2;
}

const 沟通时间格式 = "YYYY-MM-DD HH:mm";

/**
 * 在项目上记一条沟通：方式、时间、内容，加下一步时间（开了超时回收、线索 / 商机阶段必填）。
 * 记了会挂在客户上（客户页也看得到）和项目当时的节点上；填的下一步时间决定这个项目哪天没跟进会回公海
 */
function RecordFollowModal({ p, 外贸, onClose, 跑 }: {
  p: 项目详情;
  外贸: boolean;
  onClose: () => void;
  跑: (f: () => Promise<{ ok: boolean; error?: string }>, 成了?: string) => Promise<boolean>;
}) {
  const 能选类型 = 跟进类型们(外贸).filter((t) => t.value !== "TASK" && t.value !== "REMIND");
  const [type, setType] = useState<string>(能选类型[0]?.value ?? "PHONE");
  const [occurredAt, setOccurredAt] = useState(() => dayjs().format(沟通时间格式));
  const [content, setContent] = useState("");
  const [下一步时间, set下一步时间] = useState<string | null>(null);
  const [交中, set交中] = useState(false);
  const 差 = !content.trim() ? "请填写这次沟通的内容" : p.要下一步 && !下一步时间 ? "请填下一步时间：到那天还没跟进，项目会自动回到项目公海" : "";

  const 交 = async () => {
    set交中(true);
    const ok = await 跑(() => 记项目沟通Action(p.id, { type, content, occurredAt, 下一步时间 }), "已记下这条沟通");
    set交中(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open
      title="记一条沟通"
      okText="记下"
      okButtonProps={{ disabled: !!差, loading: 交中, title: 差 || undefined }}
      onCancel={onClose}
      onOk={() => void 交()}
    >
      <div style={{ display: "grid", gap: 12 }}>
        <Select aria-label="沟通方式" value={type} options={能选类型.map((t) => ({ value: t.value, label: t.label }))} onChange={(v: string) => setType(v)} />
        <DatePicker
          aria-label="沟通时间"
          showTime={{ format: "HH:mm" }}
          format={沟通时间格式}
          allowClear={false}
          style={{ width: "100%" }}
          value={dayjs(occurredAt, 沟通时间格式)}
          disabledDate={(x) => x.isAfter(dayjs(), "day")}
          onChange={(v) => v && setOccurredAt(v.format(沟通时间格式))}
        />
        <Input.TextArea aria-label="沟通内容" rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="这次聊了什么" />
        <div>
          <div style={{ marginBottom: 4 }}>
            下一步时间{p.要下一步 ? <span style={{ color: "var(--danger-text)" }}> *</span> : <span style={{ color: "var(--text-muted)" }}>（可不填）</span>}
          </div>
          <DatePicker
            aria-label="下一步时间"
            style={{ width: "100%" }}
            value={下一步时间 ? dayjs(下一步时间) : null}
            disabledDate={(x) => x.isBefore(dayjs(), "day")}
            onChange={(v) => set下一步时间(v ? v.format("YYYY-MM-DD") : null)}
          />
          {p.要下一步 && <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 12 }}>到那天还没人跟进，项目会自动回到项目公海</div>}
        </div>
        {差 && <div style={{ color: "var(--text-muted)" }}>{差}</div>}
      </div>
    </Modal>
  );
}
