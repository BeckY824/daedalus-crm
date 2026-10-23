"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Input, Select, Space, Tag } from "antd";
import { 角色名, 范围名, 业务角色, 数据范围, 默认范围, 部门最多层数, 能管人, 摊平部门 } from "@/lib/sync/dept-policy";
import type { 团队编制 } from "@/lib/sync/client";
import { 部门动作 } from "./team-actions";

/** 本机用户 id = acct_<云端账号>（lib/desktop/me.ts 团队身份id，那个文件带 node 模块，界面上不引） */
type 成员 = { accountId: string; name: string; role: string };
type 部门 = 团队编制["部门"][number];

/**
 * 设置 → 团队 → 部门与权限（团队版 1b，2026-10-23）。
 * 老板、总管理、管理员能改：建 / 改名 / 移动 / 删部门（最多 3 层），给成员分部门和业务角色，改「角色 × 范围」。
 * 隔离按一级部门算（云端推，不写进密文）；只有一个一级部门时等于没隔离，和原来一样。
 * 总管理只有老板能设、能调（角色、部门、虚线、范围）；把角色放大成全公司也只有老板能。虚线上级：虚线链上的人名下的客户只读可看。
 */
export default function DeptCard({ 编制, 成员, 我是建的人, 我, onChange }: { 编制: 团队编制; 成员: 成员[]; 我是建的人: boolean; 我: string | null; onChange: () => void }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [新名, set新名] = useState("");
  const [忙, set忙] = useState(false);
  const 我的角色 = 我 ? 编制.成员编制[我]?.bizRole : undefined;
  const 能改 = 我是建的人 || (!!我的角色 && 能管人.has(我的角色 as 业务角色));
  const 树 = 摊平部门(编制.部门);
  const 名 = new Map(编制.部门.map((d) => [d.id, d.name]));
  const 人名 = new Map(成员.map((m) => [m.accountId, m.name]));
  const 一级们 = 编制.部门.filter((d) => d.top === d.id);
  const 部门选项 = 树.map(({ d, 层 }) => ({ value: d.id, label: `${"　".repeat(层 - 1)}${d.name}` }));

  async function 做(action: string, body: Record<string, unknown>, 说明: string) {
    if (忙) return false;
    set忙(true);
    const r = await 部门动作(action, body, 说明);
    set忙(false);
    if (!r.ok) {
      message.error(r.error);
      return false;
    }
    onChange();
    router.refresh();
    return true;
  }

  function 建(parentId: string | null) {
    const 上 = parentId ? 名.get(parentId) : null;
    let 名字 = "";
    modal.confirm({
      title: 上 ? `在「${上}」下面建子部门` : "建一级部门",
      content: <Input autoFocus maxLength={40} placeholder="部门名字，如：内贸部" onChange={(e) => { 名字 = e.target.value; }} />,
      okText: "建",
      cancelText: "取消",
      onOk: async () => {
        if (!名字.trim()) { message.warning("写个名字"); throw new Error("空"); }
        if (!(await 做("dept-create", { name: 名字.trim(), parentId }, `建了部门「${名字.trim()}」${上 ? `（在「${上}」下面）` : ""}`))) throw new Error("没建成");
      },
    });
  }

  function 改(d: 部门) {
    let 名字 = d.name;
    let 上级: string | null = d.parentId;
    // 不能挪到自己或自己的下级下面，也不能超过 3 层：云端会再核一次
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
        const 挪了 = 上级 !== d.parentId;
        if (!(await 做("dept-update", { id: d.id, name: 名字.trim(), parentId: 上级 }, `把部门「${d.name}」${名字.trim() !== d.name ? `改名为「${名字.trim()}」` : ""}${挪了 ? `挪到${上级 ? `「${名.get(上级)}」下面` : "一级"}` : ""}`))) throw new Error("没改成");
      },
    });
  }

  function 删(d: 部门) {
    modal.confirm({
      title: `删掉部门「${d.name}」？`,
      content: "部门下面还有子部门或成员时删不了，先把人调走。客户不跟部门走，跟负责人走。",
      okText: "删掉",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => { await 做("dept-delete", { id: d.id }, `删了部门「${d.name}」`); },
    });
  }

  /** 调部门：直接调，不另做客户迁移、不提示交接（10-23 定：这一条不在 1b 里做）。隔离按负责人现在的部门算 */
  function 调部门(m: 成员, deptId: string | null) {
    const 原 = 编制.成员编制[m.accountId]?.deptId ?? null;
    if (原 === deptId) return;
    void 做("member", { accountId: m.accountId, deptId }, `把「${m.name}」从${原 ? `「${名.get(原)}」` : "未分部门"}调到${deptId ? `「${名.get(deptId)}」` : "未分部门"}`);
  }

  const 角色选项 = () => 业务角色
    .filter((r) => r !== "director" || 我是建的人)
    .map((r) => ({ value: r, label: 角色名[r] }));

  return (
    <section className="team-card team-dept" data-testid="team-dept">
      <h3>部门与权限</h3>
      <p className="muted">
        {一级们.length >= 2
          ? `按一级部门隔开：${一级们.map((d) => d.name).join("、")}之间互相看不到客户，查重只看到「在哪个部门」；没分部门的人算在「${名.get(编制.默认 ?? "") ?? "最早建的一级部门"}」。总管理、管理员默认看全公司。`
          : "建两个以上一级部门（如内贸、外贸）后，部门之间的客户互相看不到；现在大家看到的和原来一样。"}
        {!能改 && " 部门和角色由老板、总管理、管理员设。"}
      </p>

      <div className="team-dept-tree">
        {树.length === 0 && <p className="muted">还没有部门。</p>}
        {树.map(({ d, 层: n }) => (
          <div key={d.id} className="team-dept-row" style={{ paddingLeft: (n - 1) * 20 }}>
            <span>{d.name}</span>
            {d.top === d.id && <Tag>一级</Tag>}
            {d.id === 编制.默认 && 一级们.length >= 2 && <Tag color="blue">默认</Tag>}
            {!d.top && <Tag color="warning">上级断了</Tag>}
            {能改 && (
              <span className="team-dept-acts">
                {n < 部门最多层数 && d.top && <Button size="small" type="link" onClick={() => 建(d.id)}>加子部门</Button>}
                <Button size="small" type="link" onClick={() => 改(d)}>改</Button>
                <Button size="small" type="link" danger onClick={() => 删(d)}>删</Button>
              </span>
            )}
          </div>
        ))}
        {能改 && (
          <Space.Compact style={{ width: "100%", maxWidth: 360, marginTop: 8 }}>
            <Input value={新名} onChange={(e) => set新名(e.target.value)} placeholder="新的一级部门，如：外贸部" maxLength={40} aria-label="新的一级部门"
              onPressEnter={() => 新名.trim() && void 做("dept-create", { name: 新名.trim(), parentId: null }, `建了部门「${新名.trim()}」`).then((ok) => ok && set新名(""))} />
            <Button disabled={!新名.trim() || 忙} onClick={() => void 做("dept-create", { name: 新名.trim(), parentId: null }, `建了部门「${新名.trim()}」`).then((ok) => ok && set新名(""))}>建部门</Button>
          </Space.Compact>
        )}
      </div>

      <h3 style={{ marginTop: 16 }}>成员的部门和角色</h3>
      <ul className="team-dept-members">
        {成员.map((m) => {
          const 编 = 编制.成员编制[m.accountId];
          const 是老板 = m.role === "owner";
          const 改他 = 能改 && (我是建的人 || (!是老板 && 编?.bizRole !== "director"));
          return (
            <li key={m.accountId} data-testid={`dept-member-${m.accountId}`}>
              <b>{m.name}</b>
              <Select size="small" style={{ minWidth: 120 }} aria-label={`${m.name} 的部门`} disabled={!改他 || 忙}
                value={编?.deptId ?? "__无"} onChange={(v) => 调部门(m, v === "__无" ? null : v)}
                options={[{ value: "__无", label: "未分部门" }, ...部门选项]} />
              {是老板 ? <Tag color="gold">老板 · 总管理</Tag> : (
                <Select size="small" style={{ minWidth: 110 }} aria-label={`${m.name} 的角色`} disabled={!改他 || 忙}
                  value={编?.bizRole} options={编?.bizRole === "director" && !我是建的人 ? [{ value: "director", label: 角色名.director }] : 角色选项()}
                  onChange={(v) => void 做("member", { accountId: m.accountId, bizRole: v }, `把「${m.name}」设成了${角色名[v as 业务角色]}`)} />
              )}
              {/* 虚线上级：能只读看虚线链上的人名下的客户 */}
              {!是老板 && (
                <Select size="small" style={{ minWidth: 120 }} allowClear placeholder="虚线上级" aria-label={`${m.name} 的虚线上级`} disabled={!改他 || 忙}
                  value={编?.dottedManagerId ?? undefined}
                  options={成员.filter((x) => x.accountId !== m.accountId).map((x) => ({ value: x.accountId, label: `虚线：${x.name}` }))}
                  onChange={(v) => void 做("member", { accountId: m.accountId, dottedManagerId: v ?? null }, v ? `给「${m.name}」设了虚线上级「${人名.get(v)}」` : `去掉了「${m.name}」的虚线上级`)} />
              )}
            </li>
          );
        })}
      </ul>

      <h3 style={{ marginTop: 16 }}>每个角色看得到哪些客户</h3>
      <p className="muted">默认和原来一样：总管理、管理员看全公司，销售管理看本一级部门，其他角色看自己的（团队开了互看时看同事的）。总管理的范围只有老板能改。</p>
      <ul className="team-dept-scopes">
        {编制.角色范围.map(({ bizRole, scope }) => (
          <li key={bizRole}>
            <span className="team-dept-role">{角色名[bizRole as 业务角色] ?? bizRole}</span>
            <Select size="small" style={{ minWidth: 220 }} aria-label={`${角色名[bizRole as 业务角色] ?? bizRole} 的范围`}
              disabled={!能改 || 忙 || (bizRole === "director" && !我是建的人)} value={scope}
              options={数据范围.filter((x) => x !== "all" || 我是建的人 || 默认范围[bizRole as 业务角色] === "all" || scope === "all").map((x) => ({ value: x, label: 范围名[x] }))}
              onChange={(v) => void 做("role-scope", { bizRole, scope: v }, `把${角色名[bizRole as 业务角色] ?? bizRole}的范围改成了「${范围名[v as 数据范围]}」`)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
