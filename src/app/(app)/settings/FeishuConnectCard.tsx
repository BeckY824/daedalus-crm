"use client";

import { useState } from "react";
import { App, Button, Input, Select, Space, Tag } from "antd";
import { 测试飞书连接动作, 飞书表概况, 设飞书表 } from "./org-actions";
import type { 主表槽, 测试结果, 数据表 } from "@/lib/enterprise/feishu-connect";

/**
 * 设置 → 组织架构 →「飞书连接」（企业版，10-26）：填 App ID / Secret → 测试连接 → 贴多维表格链接、对表。
 * - 测试连接一步一步说：ID / Secret 对不对、通讯录读不读得到、多维表格读不读得到；没过的说是哪一种原因
 *   （没开权限 / 开了没发版本 / 应用没被加进多维表格 / 链接不对）。用的是框里刚填、还没保存的凭据（Secret 空着用存着的）。
 * - table_id 不用手填：测试时列出多维表格里所有数据表，按名字自动对上 8 张主表，对不上的自己在下拉里选。
 * 放在 OrgSyncCard 的飞书一栏里，App ID / Secret 和通讯录同步共用一份（草稿由那边传进来）。
 */
type 主表 = { 槽: 主表槽; 名: string; 表名: string; 已接: boolean };

type 表概况结果 = Awaited<ReturnType<typeof 飞书表概况>>;

/** 已存的对表 → 下拉的初值（OrgSyncCard 和通讯录一起读好传进来） */
function 起始(r: 表概况结果 | null) {
  const 已有: 数据表[] = [];
  const 选了: Partial<Record<主表槽, string | null>> = {};
  if (!r?.ok) return { 主表们: [] as 主表[], 链接: "", 表们: 已有, 选: 选了 };
  for (const [k, v] of Object.entries(r.概况.选) as [主表槽, 数据表 | null][]) {
    选了[k] = v?.tableId ?? null;
    if (v) 已有.push(v);
  }
  return { 主表们: r.主表们, 链接: r.概况.appToken ?? "", 表们: 已有, 选: 选了 };
}

export default function FeishuConnectCard({ 草稿, 初始 }: { 草稿: Record<string, string>; 初始: 表概况结果 | null }) {
  const { message } = App.useApp();
  const [起] = useState(() => 起始(初始));
  const [主表们] = useState<主表[]>(起.主表们);
  const [链接, set链接] = useState(起.链接);
  const [表们, set表们] = useState<数据表[]>(起.表们);
  const [选, set选] = useState<Partial<Record<主表槽, string | null>>>(起.选);
  const [结果, set结果] = useState<测试结果 | null>(null);
  const [忙, set忙] = useState<"test" | "save" | null>(null);
  const [改过表, set改过表] = useState(false);

  const 测试 = async () => {
    set忙("test");
    try {
      const r = await 测试飞书连接动作({ 填: { appId: 草稿.appId, appSecret: 草稿.appSecret }, 链接 });
      if (!r.ok) {
        message.error(r.error);
        return;
      }
      set结果(r.结果);
      const 表 = r.结果.多维表格;
      if (表) {
        set表们(表.表们);
        // 原来选的还在这个多维表格里就留着，不在的（换了链接）用自动对上的
        set选((原) => {
          const 新: Partial<Record<主表槽, string | null>> = {};
          for (const t of 主表们) {
            const 旧 = 原[t.槽];
            新[t.槽] = 旧 && 表.表们.some((x) => x.tableId === 旧) ? 旧 : 表.对上[t.槽];
          }
          return 新;
        });
        set改过表(true);
      }
    } catch {
      message.error("测试没跑成，请稍后再试");
    } finally {
      set忙(null);
    }
  };

  const 存表 = async () => {
    set忙("save");
    try {
      const r = await 设飞书表(链接, 选 as Record<string, string | null>);
      if (!r.ok) message.error(r.error);
      else {
        message.success("多维表格对照已保存，导入和同步按这个拉");
        set改过表(false);
      }
    } catch {
      message.error("没存成，请稍后再试");
    } finally {
      set忙(null);
    }
  };

  const 选项 = 表们.map((t) => ({ value: t.tableId, label: t.名 }));
  const 用掉 = new Set(Object.values(选).filter(Boolean));

  return (
    <div data-testid="feishu-connect" style={{ marginTop: 12 }}>
      <b>飞书连接</b>
      <p className="muted" style={{ margin: "4px 0 8px" }}>
        在飞书开放平台建一个企业自建应用，开通「通讯录」和「多维表格」的读取权限并发布版本，再把应用加进多维表格（多维表格右上角「…」→「添加文档应用」）。
        App Secret 存进库里是加密的，这里只显示后 4 位。
      </p>
      <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="muted">多维表格链接（不导入、只同步通讯录可以不填）</span>
          <Input value={链接} placeholder="https://xxx.feishu.cn/base/…" aria-label="多维表格链接" autoComplete="off"
            onChange={(e) => set链接(e.target.value)} />
        </label>
        <div>
          <Button type="primary" loading={忙 === "test"} disabled={!!忙} onClick={() => void 测试()} data-testid="feishu-test">测试连接</Button>
        </div>
      </div>

      {结果 && (
        <ul style={{ margin: "12px 0 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }} data-testid="feishu-test-result">
          {结果.步们.map((s) => (
            <li key={s.名}>
              <Tag color={s.通过 ? "success" : "error"}>{s.通过 ? "通过" : "没过"}</Tag>
              <b>{s.名}</b>　<span className={s.通过 ? "muted" : undefined}>{s.话}</span>
            </li>
          ))}
        </ul>
      )}

      {主表们.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <span className="muted">
            数据表对照：测试连接后按表名自动对上，对不上的在下拉里选。标「先存着」的几类还没开始导入，对好了先存下。
          </span>
          <div style={{ display: "grid", gap: 6, marginTop: 6, maxWidth: 560 }} data-testid="feishu-tables">
            {主表们.map((t) => (
              <Space key={t.槽} style={{ justifyContent: "space-between", width: "100%" }}>
                <span>
                  {t.名}{!t.已接 && <Tag style={{ marginLeft: 6 }}>先存着</Tag>}
                </span>
                <Select size="small" style={{ width: 240 }} allowClear placeholder={表们.length ? "选一张表" : "先测试连接"}
                  aria-label={`${t.名} 对应的数据表`} disabled={!表们.length || !!忙} value={选[t.槽] ?? undefined}
                  options={选项.map((o) => ({ ...o, disabled: 用掉.has(o.value) && 选[t.槽] !== o.value }))}
                  onChange={(v: string | undefined) => {
                    set选((d) => ({ ...d, [t.槽]: v ?? null }));
                    set改过表(true);
                  }} />
              </Space>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <Button disabled={!改过表 || !!忙 || !链接.trim()} loading={忙 === "save"} onClick={() => void 存表()} data-testid="feishu-tables-save">保存对照</Button>
          </div>
        </div>
      )}
    </div>
  );
}
