"use client";

import { useState } from "react";
import { App, Alert, Button, Checkbox, Dropdown, Input, InputNumber, Modal, Segmented, Table, Tag, Tooltip } from "antd";
import { MoreOutlined } from "@ant-design/icons";
import { dayjs } from "@/lib/utils";
import { 页头 } from "../OpsShell";
import { 卡片 } from "../ui";
import { 开通续费团队, 改团队到期, 停用团队, 改团队价格 } from "../actions";
import { 时长们, 时长名, 应收, 北京日期, 新到期日, type 价格表 } from "@/lib/team-pricing";

type 记录 = {
  id: string; at: string; by: string; kind: string; months: number | null; days: number | null;
  seats: number | null; amount: number | null; before: string | null; after: string | null; note: string | null;
};
type 行 = {
  id: string; name: string; active: boolean; createdAt: string; activatedAt: string | null;
  人数: number; 批次: number; 字节: number; 建的人: { name: string; email: string | null; phone: string | null } | null;
  /** 到期日（北京日期）、还剩几天（服务器算好的）、过了没有；null = 没设到期（不限期） */
  到期: { 日: string; 剩: number; 过了: boolean; iso: string } | null;
  席位: number | null;
  记录: 记录[];
};

const 大小 = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const 元 = (n: number) => `¥${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")}`;
/** 7 天内到期算「快到期」：私信提醒客户续费要留出几天 */
const 快到期天数 = 7;
/** 弹框挂在运营台里面：ops.css 的颜色变量写在 .opx 上，挂到 body 下就读不到 */
const 挂在运营台 = () => (document.querySelector(".opx") as HTMLElement | null) ?? document.body;

/** 列表里那一格「状态」：从没开通过 = 待开通；开着但过了到期日 = 已到期；关着但开通过 = 已停用 */
function 状态(r: 行) {
  if (r.active && r.到期?.过了) return <Tag color="error">已到期</Tag>;
  if (r.active) return <Tag color="success">已开通</Tag>;
  if (r.activatedAt || r.到期) return <Tag>已停用</Tag>;
  return <Tag color="warning">待开通</Tag>;
}

function 到期格(r: 行) {
  if (!r.到期) {
    // 10-15 之前开通的老团队没有到期日 = 不限期，照常同步；提醒运营者找机会设一个
    return r.active ? (
      <Tooltip title="以前开通的，没有到期日 = 不限期、照常同步。下次续费时点「开通 / 续费」，或在「改到期日」里设一个">
        <span className="opx-due opx-due-warn">未设到期</span>
      </Tooltip>
    ) : (
      <span className="opx-faint">—</span>
    );
  }
  const { 日, 剩, 过了 } = r.到期;
  const 档 = 过了 ? " opx-due-bad" : 剩 <= 快到期天数 ? " opx-due-warn" : "";
  const 话 = 过了 ? `已过期 ${Math.max(0, -剩)} 天` : 剩 === 0 ? "今天到期" : `剩 ${剩} 天`;
  return (
    <span className={`opx-due${档}`}>
      <span className="num">{日}</span>
      <small>{话}</small>
    </span>
  );
}

function 记录话(l: 记录) {
  return [
    l.kind,
    l.months ? 时长名(l.months) : l.days ? `${l.days} 天` : "",
    l.seats ? `${l.seats} 人` : "",
    l.amount !== null ? `实收 ${元(l.amount)}` : "",
    l.before !== l.after ? `到期 ${l.before ?? "未设"} → ${l.after ?? "不限期"}` : "",
    l.note ?? "",
  ].filter(Boolean).join(" · ");
}

/**
 * 团队同步（2026-10-03；10-15 起按时长开通）。新团队「待开通」：建好、人拉齐了，这里点「开通 / 续费」，
 * 选时长和人数、按价格表看应收，确认后写到期日。到期自动暂停同步，续费顺延后自动恢复。
 * 收钱走私域、运营者手动开通，不做应用内支付。我们只看得到这些元数据——密文打不开，钥匙在他们自己电脑上。
 */
export default function SyncView({ token, rows, 价格, 今天 }: { token: string; rows: 行[]; 价格: 价格表; 今天: string }) {
  const { message, modal } = App.useApp();
  const [忙, set忙] = useState<string | null>(null);
  const [开, set开] = useState<行 | null>(null);
  const [改, set改] = useState<行 | null>(null);
  const [改价, set改价] = useState(false);

  function 停(r: 行) {
    modal.confirm({
      title: `停用「${r.name}」的同步？`,
      content: "成员推拉都会停下，各自电脑上的数据不受影响；到期日不动，之后「开通 / 续费」照常顺延。",
      okText: "停用",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        set忙(r.id);
        const res = await 停用团队({ token, teamId: r.id });
        set忙(null);
        if (res.ok) message.success("已停用");
        else message.error(res.error ?? "操作失败");
      },
    });
  }

  const 待开通 = rows.filter((r) => !r.active && !r.activatedAt && !r.到期).length;
  const 已到期 = rows.filter((r) => r.active && r.到期?.过了).length;
  const 快到期 = rows.filter((r) => r.active && r.到期 && !r.到期.过了 && r.到期.剩 <= 快到期天数).length;
  const 说明 = [`${rows.length} 个团队`, `待开通 ${待开通}`, 已到期 ? `已到期 ${已到期}` : "", 快到期 ? `${快到期天数} 天内到期 ${快到期}` : ""].filter(Boolean).join(" · ");

  return (
    <>
      <页头 标题="团队同步" 说明={说明} />
      <卡片 标题="价格表" 说明="每人 · 客户在桌面端「设置 → 团队」里看得到，改了马上生效" 右={<Button size="small" onClick={() => set改价(true)}>改价格</Button>}>
        <div className="opx-prices">
          {价格.prices.map((p) => (
            <div key={p.months} className="opx-price">
              <span>{时长名(p.months)}</span>
              <b className="num">{元(p.perSeat)}</b>
              <small className="num">{p.months > 1 ? `折合每月 ${元(Math.round((p.perSeat / p.months) * 10) / 10)}` : "每人每月"}</small>
            </div>
          ))}
          <div className="opx-price">
            <span>试用</span>
            <b className="num">{价格.trialDays ? `${价格.trialDays} 天` : "不提供"}</b>
            <small>开通时可选，不收钱</small>
          </div>
        </div>
      </卡片>
      <卡片 平>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          locale={{ emptyText: "还没有人建团队" }}
          expandable={{
            rowExpandable: (r) => r.记录.length > 0,
            expandedRowRender: (r) => (
              <ul className="opx-plan-log">
                {r.记录.map((l) => (
                  <li key={l.id}>
                    <span className="num">{dayjs(l.at).format("YYYY-MM-DD HH:mm")}</span>
                    <span>{记录话(l)}</span>
                    <span className="opx-faint">{l.by}</span>
                  </li>
                ))}
              </ul>
            ),
          }}
          columns={[
            { title: "团队", dataIndex: "name", key: "n" },
            {
              title: "建的人", key: "o",
              render: (_, r) => (r.建的人 ? (
                <span className="opx-two">
                  <span>{r.建的人.name}</span>
                  <small>{r.建的人.email ?? r.建的人.phone ?? ""}</small>
                </span>
              ) : "—"),
            },
            {
              title: "人数 / 席位", key: "p", width: 100,
              render: (_, r) => (
                <span className="num">
                  {r.人数}
                  {r.席位 ? ` / ${r.席位}` : ""}
                  {r.席位 !== null && r.人数 > r.席位 && (
                    <Tooltip title="人数超过买的席位：本次只提示、不拦，续费时按现有人数开">
                      <Tag color="error" style={{ marginLeft: 6 }}>超 {r.人数 - r.席位}</Tag>
                    </Tooltip>
                  )}
                </span>
              ),
            },
            {
              title: "批次 / 占用", key: "b", width: 100,
              render: (_, r) => (
                <span className="opx-two num">
                  <span>{r.批次} 批</span>
                  <small>{大小(r.字节)}</small>
                </span>
              ),
            },
            { title: "建于", key: "c", width: 106, render: (_, r) => <span className="num opx-nowrap">{dayjs(r.createdAt).format("YYYY-MM-DD")}</span> },
            { title: "到期", key: "d", width: 110, render: (_, r) => 到期格(r) },
            { title: "状态", key: "a", width: 76, render: (_, r) => 状态(r) },
            {
              title: "", key: "act", width: 150,
              render: (_, r) => (
                <span className="opx-row-acts">
                  <Button size="small" type="primary" onClick={() => set开(r)}>开通 / 续费</Button>
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        { key: "due", label: "改到期日" },
                        ...(r.active ? [{ type: "divider" as const }, { key: "off", label: "停用", danger: true }] : []),
                      ],
                      onClick: ({ key }) => (key === "due" ? set改(r) : 停(r)),
                    }}
                  >
                    <Button size="small" type="text" icon={<MoreOutlined />} loading={忙 === r.id} aria-label={`${r.name} 更多操作`} />
                  </Dropdown>
                </span>
              ),
            },
          ]}
        />
      </卡片>
      {开 && <OpenRenewModal key={开.id} token={token} r={开} 价格={价格} onClose={() => set开(null)} />}
      {改 && <EditDueModal key={改.id} token={token} r={改} 今天={今天} onClose={() => set改(null)} />}
      {改价 && <PriceModal token={token} 价格={价格} onClose={() => set改价(false)} />}
    </>
  );
}

/** 开通 / 续费（英文名：react-hooks 规则只认大写字母开头的才是组件）：选时长和人数 → 应收（价格表算）→ 实收（默认等于应收，打折可以改）→ 新到期日预览 */
function OpenRenewModal({ token, r, 价格, onClose }: { token: string; r: 行; 价格: 价格表; onClose: () => void }) {
  const { message } = App.useApp();
  const 选项 = [...(价格.trialDays ? [{ value: 0, label: "试用" }] : []), ...时长们.map((x) => ({ value: x.months as number, label: x.label }))];
  const 每人价 = (m: number) => (m ? 价格.prices.find((p) => p.months === m)?.perSeat ?? 0 : 0);
  const [月, set月] = useState(1);
  const [人, set人] = useState(Math.max(1, r.人数));
  const [实收, set实收] = useState<number | null>(应收(每人价(1), Math.max(1, r.人数)));
  const [备注, set备注] = useState("");
  const [交, set交] = useState(false);
  const 该收 = 应收(每人价(月), 人);
  const 新 = 北京日期(新到期日(r.到期 ? new Date(r.到期.iso) : null, 月 ? { months: 月 } : { days: 价格.trialDays }));

  // 换时长、换人数：实收跟着应收走（先选好时长人数，最后再改实收）
  const 换 = (m: number, n: number) => {
    set月(m);
    set人(n);
    set实收(应收(每人价(m), n));
  };

  async function 确认() {
    set交(true);
    const res = await 开通续费团队({ token, teamId: r.id, ...(月 ? { months: 月 } : { days: 价格.trialDays }), seats: 人, amount: 月 ? 实收 ?? 0 : null, note: 备注 });
    set交(false);
    if (!res.ok) return void message.error(res.error ?? "操作失败");
    message.success(`已开通，到期 ${res.paidUntil}`);
    onClose();
  }

  return (
    <Modal open getContainer={挂在运营台} title={`开通 / 续费：${r.name}`} onCancel={onClose} okText="确认开通" confirmLoading={交} onOk={() => void 确认()} width={540}>
      <div className="opx-form">
        <label>时长</label>
        <Segmented<number> block value={月} onChange={(v) => 换(v, 人)} options={选项} />
        <label>人数</label>
        <div>
          <InputNumber min={1} max={100} precision={0} value={人} onChange={(v) => 换(月, Math.max(1, Number(v) || 1))} suffix="人" style={{ width: 120 }} />
          <span className="opx-faint opx-form-tip">团队现在 {r.人数} 人{r.席位 ? ` · 原来买了 ${r.席位} 席` : ""}</span>
        </div>
        <label>应收</label>
        <div>
          <b className="num opx-form-big">{元(该收)}</b>
          <span className="opx-faint opx-form-tip">{月 ? `每人 ${元(每人价(月))} × ${人} 人` : `试用 ${价格.trialDays} 天，不收钱`}</span>
        </div>
        {月 > 0 && (
          <>
            <label>实收</label>
            <div>
              <InputNumber min={0} max={100000} precision={2} value={实收} onChange={(v) => set实收(v === null ? null : Number(v))} prefix="¥" style={{ width: 140 }} />
              <span className="opx-faint opx-form-tip">打折、补差价就改这里</span>
            </div>
          </>
        )}
        <label>备注</label>
        <Input value={备注} onChange={(e) => set备注(e.target.value)} maxLength={200} placeholder="如：微信转账、小红书私信谈的" />
      </div>
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        title={<>到期日：{r.到期 ? `${r.到期.日}${r.到期.过了 ? "（已过期）" : ""}` : "未设"} → <b className="num">{新}</b></>}
        description={r.到期 && !r.到期.过了 ? "还没到期，从原到期日往后顺延。" : r.到期 ? "已经过期，从今天算。" : r.active ? "原来不限期；确认后从今天算，到期自动暂停同步。" : "从今天算，确认后马上开始同步。"}
      />
    </Modal>
  );
}

/** 手动改到期日（纠错用，不收钱）。勾「不限期」= 清掉到期日 */
function EditDueModal({ token, r, 今天, onClose }: { token: string; r: 行; 今天: string; onClose: () => void }) {
  const { message } = App.useApp();
  const [日, set日] = useState(r.到期?.日 ?? 今天);
  const [不限, set不限] = useState(!r.到期);
  const [备注, set备注] = useState("");
  const [交, set交] = useState(false);
  async function 确认() {
    if (!不限 && !/^\d{4}-\d{2}-\d{2}$/.test(日)) return void message.error("选一个日期");
    set交(true);
    const res = await 改团队到期({ token, teamId: r.id, date: 不限 ? null : 日, note: 备注 });
    set交(false);
    if (!res.ok) return void message.error(res.error ?? "操作失败");
    message.success("到期日已改");
    onClose();
  }
  return (
    <Modal open getContainer={挂在运营台} title={`改到期日：${r.name}`} onCancel={onClose} okText="保存" confirmLoading={交} onOk={() => void 确认()} width={480}>
      <p className="opx-faint opx-form-lead">只用来纠错；收了钱请用「开通 / 续费」，会记下时长和金额。到期日当天还能用，过了那天（北京时间）暂停同步。</p>
      <div className="opx-form">
        <label>到期日</label>
        <div>
          <Input type="date" value={日} disabled={不限} onChange={(e) => set日(e.target.value)} style={{ width: 170 }} />
          <Checkbox checked={不限} onChange={(e) => set不限(e.target.checked)} style={{ marginLeft: 12 }}>不限期</Checkbox>
        </div>
        <label>备注</label>
        <Input value={备注} onChange={(e) => set备注(e.target.value)} maxLength={200} placeholder="为什么改，如：上次少算了 3 天" />
      </div>
      {!r.active && <Alert type="warning" showIcon style={{ marginTop: 16 }} title="这个团队现在没开通：改到期日不会打开同步，要开请用「开通 / 续费」" />}
    </Modal>
  );
}

function PriceModal({ token, 价格, onClose }: { token: string; 价格: 价格表; onClose: () => void }) {
  const { message } = App.useApp();
  const [价, set价] = useState<Record<number, number | null>>(Object.fromEntries(价格.prices.map((p) => [p.months, p.perSeat])));
  const [试用, set试用] = useState<number | null>(价格.trialDays);
  const [交, set交] = useState(false);
  async function 确认() {
    set交(true);
    const res = await 改团队价格({ token, prices: 时长们.map((x) => ({ months: x.months, perSeat: Number(价[x.months]) })), trialDays: Number(试用 ?? 0) });
    set交(false);
    if (!res.ok) return void message.error(res.error ?? "操作失败");
    message.success("价格已改，客户下次打开「设置 → 团队」就是新价");
    onClose();
  }
  return (
    <Modal open getContainer={挂在运营台} title="改价格（每人）" onCancel={onClose} okText="保存" confirmLoading={交} onOk={() => void 确认()} width={420}>
      <div className="opx-form">
        {时长们.map((x) => (
          <div key={x.months} style={{ display: "contents" }}>
            <label>{x.label}</label>
            <InputNumber min={0} max={100000} precision={2} value={价[x.months]} onChange={(v) => set价({ ...价, [x.months]: v === null ? null : Number(v) })} prefix="¥" style={{ width: 140 }} />
          </div>
        ))}
        <label>试用</label>
        <InputNumber min={0} max={90} precision={0} value={试用} onChange={(v) => set试用(v === null ? null : Number(v))} suffix="天" style={{ width: 140 }} />
      </div>
      <p className="opx-faint opx-form-lead">试用填 0 = 不提供试用。已经开通的团队不受影响，只影响之后的开通 / 续费和客户看到的价格。</p>
    </Modal>
  );
}
