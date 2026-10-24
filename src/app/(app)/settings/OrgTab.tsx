"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Select, Space, Switch, Tag } from "antd";
import { 角色名, 业务角色, 部门最多层数 } from "@/lib/sync/dept-policy";
import { 部门树, type 组织部门 } from "@/lib/enterprise/org-tree";
import { 规则, 规则名们, type 规则名 } from "@/lib/enterprise/rules-table";
import { 字段, 字段名们, 字段级别of, type 字段配置, type 字段名 } from "@/lib/enterprise/field-perm-table";
import { 建部门, 改部门, 删部门, 设成员, 设规则, 设字段权限, type 成员改动 } from "./org-actions";

export type 组织架构 = {
  部门: 组织部门[];
  /** 在职的人；自动上级 = 没指定直属上级时按部门推出来的那位（名字），推不出来是 null */
  成员: { id: string; name: string; deptId: string | null; bizRole: string; line: string | null; managerId: string | null; dottedManagerId: string | null; 自动上级: string | null }[];
  能改: boolean;
  /** 账号管理员：总管理、管理员两个角色只有老板能给、能动 */
  是老板: boolean;
  /** 每条组织规则的开关，默认都关 */
  规则开着: Record<规则名, boolean>;
  /** 「角色 × 字段」表，只有和默认（能改）不一样的格 */
  字段权限: 字段配置;
};
type 结果 = Promise<{ ok: boolean; error?: string }>;

const 总管级 = (r: string) => r === "director" || r === "admin";
/** 开关的 data-testid：第一条沿用老名字，E2E 在用 */
const 规则testid: Record<规则名, string> = { 按组织看客户: "org-rule-scope", 线索分配: "org-rule-lead-assign", 字段权限: "org-rule-field-perm" };
const 级别名 = { 改: "能改", 看: "只能看", 藏: "看不到" } as const;

/**
 * 设置 → 组织架构（企业版，2026-10-24）：部门树、每个人的部门 / 角色 / 业务线 / 直属上级 / 虚线上级。
 * 直属上级不填 = 按部门往上找销售管理；虚线上级只能看他的客户，不能改、不能转。
 * 老板和总管理员能改，其他人只看。
 */
export default function OrgTab({ value }: { value: 组织架构 }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [新名, set新名] = useState("");
  const [忙, set忙] = useState(false);
  const [表, set表] = useState<字段配置>(value.字段权限);
  const 表改了 = JSON.stringify(表) !== JSON.stringify(value.字段权限);
  const { 能改, 是老板 } = value;
  const 树 = 部门树(value.部门);
  const 名 = new Map(value.部门.map((d) => [d.id, d.name]));
  const 部门选项 = 树.map(({ d, 层 }) => ({ value: d.id, label: `${"　".repeat(层 - 1)}${d.name}` }));

  const 跑 = async (f: () => 结果, 成了?: string) => {
    if (忙) return false;
    set忙(true);
    try {
      const r = await f();
      if (!r.ok) message.error(r.error ?? "没改成，请稍后再试");
      else {
        if (成了) message.success(成了);
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

  function 建(parentId: string | null) {
    const 上 = parentId ? 名.get(parentId) : null;
    let 名字 = "";
    modal.confirm({
      title: 上 ? `在「${上}」下面建子部门` : "建一级部门",
      content: <Input autoFocus maxLength={40} placeholder="部门名字，如：内贸一组" aria-label="部门名字" onChange={(e) => { 名字 = e.target.value; }} />,
      okText: "建",
      cancelText: "取消",
      onOk: async () => {
        if (!名字.trim()) { message.warning("写个名字"); throw new Error("空"); }
        if (!(await 跑(() => 建部门(名字, parentId)))) throw new Error("没建成");
      },
    });
  }

  function 改(d: 组织部门) {
    let 名字 = d.name;
    let 上级: string | null = d.parentId;
    // 不能挪到自己或下级底下、不能超过 3 层：服务端会再核一次
    const 可选 = 树.filter((x) => x.d.id !== d.id && x.层 < 部门最多层数).map(({ d: x, 层 }) => ({ value: x.id, label: `${"　".repeat(层 - 1)}${x.name}` }));
    modal.confirm({
      title: `改部门「${d.name}」`,
      content: (
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input defaultValue={d.name} maxLength={40} aria-label="部门名字" onChange={(e) => { 名字 = e.target.value; }} />
          <Select defaultValue={d.parentId ?? "__顶"} style={{ width: "100%" }} aria-label="上级部门"
            options={[{ value: "__顶", label: "（一级部门，没有上级）" }, ...可选]} onChange={(v) => { 上级 = v === "__顶" ? null : v; }} />
        </Space>
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: async () => {
        if (!名字.trim()) { message.warning("写个名字"); throw new Error("空"); }
        if (!(await 跑(() => 改部门(d.id, { name: 名字, parentId: 上级 })))) throw new Error("没改成");
      },
    });
  }

  function 删(d: 组织部门) {
    modal.confirm({
      title: `删掉部门「${d.name}」？`,
      content: "部门下面还有子部门或人时删不了，先把人换到别的部门。客户不跟部门走，跟负责人走。",
      okText: "删掉",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => { await 跑(() => 删部门(d.id), `删了部门「${d.name}」`); },
    });
  }

  // 上级下拉的空值传 null 不传 undefined：undefined 会让 antd 当不受控，保存失败时框里还留着刚选的人
  const 设 = (id: string, 改: 成员改动) => void 跑(() => 设成员(id, 改));
  const 设格 = (f: 字段名, r: 业务角色, v: keyof typeof 级别名) => set表((t) => {
    const 行 = { ...t[f] };
    if (v === "改") delete 行[r];
    else 行[r] = v;
    const { [f]: _旧, ...别的 } = t;
    return Object.keys(行).length ? { ...别的, [f]: 行 } : 别的;
  });
  const 只看 = !能改 && <span style={{ color: "var(--text-muted)" }}>只有老板和总管理员能改</span>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card title="组织规则" extra={只看}>
        <p className="muted">每条规则单独开关，默认都关着：关着时和团队版一样，按原来的方式看客户。先把下面的部门和上级填好再打开。</p>
        <div style={{ display: "grid", gap: 12 }}>
          {规则名们.map((名) => (
            <Space align="start" key={名}>
              <Switch checked={value.规则开着[名]} disabled={!能改 || 忙} aria-label={规则[名].名} data-testid={规则testid[名]}
                onChange={(v) => void 跑(() => 设规则(v, 名), v ? `已打开「${规则[名].名}」` : `已关掉「${规则[名].名}」`)} />
              <div>
                <b>{规则[名].名}</b>
                <p className="muted" style={{ margin: 0 }}>{规则[名].说明}</p>
              </div>
            </Space>
          ))}
        </div>
      </Card>

      <Card title="字段权限" extra={只看}>
        <p className="muted">
          打开上面的「{规则.字段权限.名}」才生效。每格是这个角色对这个字段能做什么：能改、只能看；电话还能选看不到（页面、导出、AI 助手里都打码）。
          没动过的格都是能改。老板不受限。
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="org-field-perm" data-testid="org-field-perm">
            <thead>
              <tr>
                <th>字段</th>
                {业务角色.map((r) => <th key={r}>{角色名[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {字段名们.map((f) => (
                <tr key={f}>
                  <th scope="row">{字段[f].名}<div className="muted">{字段[f].用在}</div></th>
                  {业务角色.map((r) => (
                    <td key={r}>
                      <Select size="small" style={{ minWidth: 88 }} aria-label={`${角色名[r]} 对「${字段[f].名}」`} disabled={!能改 || 忙}
                        value={字段级别of(表, f, r)} onChange={(v) => 设格(f, r, v)}
                        options={(字段[f].能藏 ? (["改", "看", "藏"] as const) : (["改", "看"] as const)).map((x) => ({ value: x, label: 级别名[x] }))} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {能改 && (
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" disabled={!表改了 || 忙} data-testid="org-field-perm-save" onClick={() => void 跑(() => 设字段权限(表), "字段权限已保存")}>保存字段权限</Button>
            <Button disabled={!表改了 || 忙} onClick={() => set表(value.字段权限)}>放弃修改</Button>
          </Space>
        )}
      </Card>

      <Card title="部门" extra={只看}>
        <p className="muted">部门最多 {部门最多层数} 层。销售没指定直属上级时，按所在部门往上找销售管理当他的上级。</p>
        <div className="team-dept-tree" data-testid="org-depts">
          {树.length === 0 && <p className="muted">还没有部门。</p>}
          {树.map(({ d, 层: n, 断 }) => (
            <div key={d.id} className="team-dept-row" style={{ paddingLeft: (n - 1) * 20 }}>
              <span>{d.name}</span>
              {断 && <Tag color="warning">上级断了</Tag>}
              {能改 && (
                <span className="team-dept-acts">
                  {n < 部门最多层数 && !断 && <Button size="small" type="link" onClick={() => 建(d.id)}>加子部门</Button>}
                  <Button size="small" type="link" onClick={() => 改(d)}>改</Button>
                  <Button size="small" type="link" danger onClick={() => 删(d)}>删</Button>
                </span>
              )}
            </div>
          ))}
          {能改 && (
            <Space.Compact style={{ width: "100%", maxWidth: 360, marginTop: 8 }}>
              <Input value={新名} onChange={(e) => set新名(e.target.value)} placeholder="新的一级部门，如：外贸部" maxLength={40} aria-label="新的一级部门"
                onPressEnter={() => 新名.trim() && void 跑(() => 建部门(新名, null)).then((ok) => ok && set新名(""))} />
              <Button disabled={!新名.trim() || 忙} onClick={() => void 跑(() => 建部门(新名, null)).then((ok) => ok && set新名(""))}>建部门</Button>
            </Space.Compact>
          )}
        </div>
      </Card>

      <Card title="每个人的部门、角色和上级" extra={只看}>
        <p className="muted">业务线用来分线索：内贸线索只分给内贸的人，外贸同理，「两边都做」两种都能分到。虚线上级只能看他的客户，不能改、不能转。</p>
        <ul className="team-dept-members" data-testid="org-members">
          {value.成员.map((m) => {
            const 改他 = 能改 && (是老板 || !总管级(m.bizRole));
            const 别人 = value.成员.filter((x) => x.id !== m.id).map((x) => ({ value: x.id, label: x.name }));
            return (
              <li key={m.id} data-testid={`org-member-${m.id}`}>
                <b>{m.name}</b>
                <Select size="small" style={{ minWidth: 120 }} aria-label={`${m.name} 的部门`} disabled={!改他 || 忙}
                  value={m.deptId ?? "__无"} onChange={(v) => 设(m.id, { deptId: v === "__无" ? null : v })}
                  labelRender={({ value: v }) => 名.get(String(v)) ?? "未分部门"}
                  options={[{ value: "__无", label: "未分部门" }, ...部门选项]} />
                <Select size="small" style={{ minWidth: 110 }} aria-label={`${m.name} 的角色`} disabled={!改他 || 忙}
                  value={m.bizRole} onChange={(v) => 设(m.id, { bizRole: v })}
                  options={业务角色.filter((r) => 是老板 || !总管级(r) || r === m.bizRole).map((r) => ({ value: r, label: 角色名[r] }))} />
                <Select size="small" style={{ minWidth: 110 }} aria-label={`${m.name} 的业务线`} disabled={!改他 || 忙}
                  value={m.line ?? "__都"} onChange={(v) => 设(m.id, { line: v === "__都" ? null : v })}
                  options={[{ value: "__都", label: "两边都做" }, { value: "内贸", label: "内贸" }, { value: "外贸", label: "外贸" }]} />
                <Select size="small" style={{ minWidth: 140 }} allowClear showSearch optionFilterProp="label" aria-label={`${m.name} 的直属上级`} disabled={!改他 || 忙}
                  placeholder={m.自动上级 ? `直属：自动（${m.自动上级}）` : "直属：没有"}
                  value={m.managerId ?? null} onChange={(v) => 设(m.id, { managerId: v ?? null })}
                  options={别人.map((x) => ({ ...x, label: `直属：${x.label}` }))} />
                <Select size="small" style={{ minWidth: 140 }} allowClear showSearch optionFilterProp="label" aria-label={`${m.name} 的虚线上级`} disabled={!改他 || 忙}
                  placeholder="虚线上级（只能看）"
                  value={m.dottedManagerId ?? null} onChange={(v) => 设(m.id, { dottedManagerId: v ?? null })}
                  options={别人.map((x) => ({ ...x, label: `虚线：${x.label}` }))} />
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
