"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Popconfirm, Switch, Tag } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { FOLLOW_TYPES } from "@/lib/constants";
import { 全部跟进类型, 新渠道值, 非渠道, 渠道名上限, 自定义上限, type FollowTypeConfig } from "@/lib/follow-types";
import { saveFollowTypeSettings } from "./actions";

/** 表单里的一行：内置的有原名（清空名字 = 用回原名），自定义的没有 */
type 行 = { value: string; label: string; 原名?: string; 显示: boolean };

const 原名表 = Object.fromEntries(FOLLOW_TYPES.map((t) => [t.value, t.label])) as Record<string, string>;

function 起始行(cfg: FollowTypeConfig): 行[] {
  return 全部跟进类型(cfg)
    .filter((t) => !非渠道.has(t.value) && !cfg.custom.some((c) => c.value === t.value && c.deleted))
    .map((t) => {
      const c = cfg.custom.find((x) => x.value === t.value);
      return c
        ? { value: t.value, label: c.label, 显示: !c.hidden }
        : { value: t.value, label: cfg.rename[t.value] ?? "", 原名: 原名表[t.value], 显示: !cfg.hidden.includes(t.value) };
    });
}

/** 表单 → 配置。删掉的自定义渠道不带回去：服务端会把它留成「已删」，老记录还叫得出原名（settings/actions.ts saveFollowTypeSettings） */
function 成配置(行们: 行[]): FollowTypeConfig {
  const rename: Record<string, string> = {};
  const hidden: string[] = [];
  const custom: FollowTypeConfig["custom"] = [];
  for (const r of 行们) {
    const 名 = r.label.trim();
    if (r.原名) {
      if (名 && 名 !== r.原名) rename[r.value] = 名;
      if (!r.显示) hidden.push(r.value);
    } else custom.push({ value: r.value, label: 名, ...(r.显示 ? {} : { hidden: true }) });
  }
  return { rename, hidden, custom };
}

/**
 * 设置里的「跟进渠道」（D-48，2026-10-27 用户：「老板和管理员可以，业务员保持同步」）：
 * 内置的改名、藏起来，自己加渠道。存的值不变，改名只改显示；藏起来、删掉的下拉里不再出现，老记录照旧显示。
 * 只有能改的人看得到这一栏（SettingsBody 算 能改跟进渠道），改完随团队同步到业务员的电脑和手机上
 */
export default function FollowTypesTab({ value }: { value: FollowTypeConfig }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [行们, set行们] = useState<行[]>(() => 起始行(value));
  const [忙, set忙] = useState(false);
  const 改 = (v: string, patch: Partial<行>) => set行们((rs) => rs.map((r) => (r.value === v ? { ...r, ...patch } : r)));
  const 自定义数 = 行们.filter((r) => !r.原名).length;

  function 加() {
    const v = 新渠道值([...行们.map((r) => r.value), ...value.custom.map((c) => c.value)]);
    // 新渠道排在内置的后面、「其他记录」前面，和下拉里的顺序一样
    set行们((rs) => {
      const i = rs.findIndex((r) => r.value === "OTHER");
      const 新 = { value: v, label: "", 显示: true };
      return i < 0 ? [...rs, 新] : [...rs.slice(0, i), 新, ...rs.slice(i)];
    });
  }

  async function 存() {
    if (行们.some((r) => !r.原名 && !r.label.trim())) {
      message.error("新加的渠道还没起名字");
      return;
    }
    set忙(true);
    try {
      const res = await saveFollowTypeSettings(成配置(行们));
      if (res.ok) {
        message.success("已保存，同事那边同步后就能选");
        router.refresh();
      } else message.error(res.error);
    } catch {
      message.error("没保存上，再试一次");
    } finally {
      set忙(false);
    }
  }

  return (
    <Card title="跟进渠道">
      <div style={{ color: "var(--text-muted)", marginBottom: 16 }}>
        记跟进时能选哪些渠道。改名只改显示，以前记的跟着显示新名；关掉「能选」或删掉的渠道，下拉里不再出现，以前记的照旧显示。业务员只能从这里面选。
      </div>
      {行们.map((r) => (
        <div key={r.value} className="ftype-row" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
          <Input
            style={{ flex: "1 1 auto", minWidth: 0 }}
            maxLength={渠道名上限}
            value={r.label}
            placeholder={r.原名 ?? "渠道名，比如：抖音私信"}
            aria-label={r.原名 ? `「${r.原名}」的名字` : "新渠道的名字"}
            onChange={(e) => 改(r.value, { label: e.target.value })}
          />
          {r.原名 ? <Tag style={{ margin: 0, flex: "none" }}>内置</Tag> : <Tag color="blue" style={{ margin: 0, flex: "none" }}>自己加的</Tag>}
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flex: "none" }}>
            <Switch
              size="small"
              checked={r.显示}
              // 「其他记录」是认不出的渠道的落脚处，不让关
              disabled={r.value === "OTHER"}
              aria-label={`${r.label.trim() || r.原名 || "新渠道"}能选`}
              onChange={(on) => 改(r.value, { 显示: on })}
            />
            能选
          </span>
          {r.原名 ? (
            <span style={{ width: 32, flex: "none" }} />
          ) : (
            <Popconfirm title="删掉这个渠道？" description="以前用它记的跟进照旧显示原名" okText="删掉" cancelText="不删" onConfirm={() => set行们((rs) => rs.filter((x) => x.value !== r.value))}>
              <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删掉「${r.label.trim() || "新渠道"}」`} style={{ flex: "none" }} />
            </Popconfirm>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Button icon={<PlusOutlined />} disabled={自定义数 >= 自定义上限} onClick={加}>加一个渠道</Button>
        <Button type="primary" loading={忙} onClick={() => void 存()}>保存</Button>
      </div>
    </Card>
  );
}
