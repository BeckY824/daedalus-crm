"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Select, Space, Tag } from "antd";
import { 角色名, 业务角色, 部门最多层数 } from "@/lib/sync/dept-policy";
import { 部门树, type 组织部门 } from "@/lib/enterprise/org-tree";
import { 建部门, 改部门, 删部门, 设成员, type 成员改动 } from "./org-actions";

export type 组织架构 = {
  部门: 组织部门[];
  /** 在职的人；自动上级 = 没指定直属上级时按部门推出来的那位（名字），推不出来是 null */
  成员: { id: string; name: string; deptId: string | null; bizRole: string; line: string | null; managerId: string | null; dottedManagerId: string | null; 自动上级: string | null }[];
  能改: boolean;
  /** 账号管理员：总管理、管理员两个角色只有老板能给、能动 */
  是老板: boolean;
};
type 结果 = Promise<{ ok: boolean; error?: string }>;

const 总管级 = (r: string) => r === "director" || r === "admin";

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
  const 只看 = !能改 && <span style={{ color: "var(--text-muted)" }}>只有老板和总管理员能改</span>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
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
