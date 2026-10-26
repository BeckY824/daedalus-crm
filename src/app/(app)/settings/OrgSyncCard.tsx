"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Select, Space, Switch, Tag } from "antd";
import { 部门最多层数 } from "@/lib/sync/dept-policy";
import { 通讯录概况, 飞书表概况, 设通讯录同步, 立即同步通讯录, 设职务对照, 设通讯录凭据, 设通讯录间隔, type 通讯录一栏 } from "./org-actions";
import FeishuConnectCard from "./FeishuConnectCard";

/**
 * 设置 → 组织架构 →「通讯录同步」（企业版 F1，10-26）：飞书 / 钉钉的部门、成员、直属上级、职务每小时（可改每半小时）拉一次，写进组织架构。
 * 只读通讯录，不往回写。只有老板和总管理员看得到这一栏（里面有连接凭据）。
 * - 凭据：App Secret 加密存库，只显示后 4 位，空着保存 = 不改；也可以用服务器环境变量。飞书一栏下面是「飞书连接」：测试连接、对多维表格。
 * - 职务对照：客户自己起的职务名对到默认权限表的角色上；没对上的人业务角色不动。
 * - 这边手动改过某人的业务角色以后，同步不再覆盖他。
 */
const 间隔选项 = [{ value: 60, label: "每小时" }, { value: 30, label: "每半小时" }];
const 结果色: Record<string, string> = { 成功: "success", 没变化: "default", 没接: "warning", 出错: "error", 跳过: "default" };

export default function OrgSyncCard() {
  const router = useRouter();
  const { message } = App.useApp();
  const [数据, set数据] = useState<{ 来源们: 通讯录一栏[]; 角色们: { value: string; label: string }[] } | null>(null);
  const [错, set错] = useState<string | null>(null);
  const [忙, set忙] = useState<string | null>(null);
  const [凭据草稿, set凭据草稿] = useState<Record<string, Record<string, string>>>({});
  const [, 开始刷新] = useTransition();

  const 用上 = useCallback((r: Awaited<ReturnType<typeof 通讯录概况>>) => {
    if (r.ok) {
      set数据({ 来源们: r.来源们, 角色们: r.角色们 });
      set错(null);
    } else set错(r.error);
  }, []);
  const 读 = useCallback(async () => 用上(await 通讯录概况()), [用上]);
  // 飞书连接那块的对表也在这一次一起读：分两次读，卡片先出来、对表后冒出来，截图和用的人都看到页面跳一下
  const [表概况, set表概况] = useState<Awaited<ReturnType<typeof 飞书表概况>> | null>(null);
  useEffect(() => {
    void Promise.all([通讯录概况(), 飞书表概况()]).then(([r, 表]) => {
      set表概况(表);
      用上(r);
    });
  }, [用上]);

  const 跑 = async (键: string, f: () => Promise<{ ok: boolean; error?: string }>, 成了: string | null) => {
    set忙(键);
    try {
      const r = await f();
      if (!r.ok) message.error(r.error ?? "没改成，请稍后再试");
      else if (成了) message.success(成了);
      await 读();
      if (r.ok) 开始刷新(() => router.refresh());
      return r.ok;
    } catch {
      message.error("没改成，请稍后再试");
      return false;
    } finally {
      set忙(null);
    }
  };

  const 同步 = (s: 通讯录一栏) =>
    跑(`sync-${s.源}`, async () => {
      const r = await 立即同步通讯录(s.源);
      if (!r.ok) return r;
      const { 结果, 话 } = r.一次;
      if (结果 === "成功" || 结果 === "没变化") message.success(`${s.名}通讯录：${话}`);
      else message.warning(`${s.名}通讯录：${话}`);
      return { ok: true };
    }, null);

  const 存凭据 = (s: 通讯录一栏) =>
    跑(`cred-${s.源}`, () => 设通讯录凭据(s.源, 凭据草稿[s.源] ?? {}), `${s.名}连接凭据已保存`).then(
      (ok) => ok && set凭据草稿(({ [s.源]: _, ...别的 }) => 别的),
    );

  if (错) return <Card title="通讯录同步"><p className="muted">{错}</p></Card>;
  if (!数据) return <Card title="通讯录同步" loading />;

  return (
    <Card title="通讯录同步" data-testid="org-sync">
      <p className="muted">
        打开后按设定的频率（默认每小时）从飞书 / 钉钉拉一次部门、成员、直属上级和职务，写进下面的组织架构；只读不写回。
        超过 {部门最多层数} 层的部门并到第 3 层；新来的人会建账号，但要在用户管理里设密码才能登录；那边离职的人这边不自动停用，请走离职交接。
        这边手动改过的业务角色，同步不会覆盖。拉的时候出错整次撤回，下次再试。
      </p>
      <div style={{ display: "grid", gap: 24 }}>
        {数据.来源们.map((s) => {
          const 草稿 = 凭据草稿[s.源] ?? {};
          const 改过凭据 = Object.keys(草稿).length > 0;
          return (
            <section key={s.源} data-testid={`org-sync-${s.源}`} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <Space align="center" wrap>
                <b>{s.名}</b>
                <Switch checked={s.开} disabled={!!忙} aria-label={`${s.名}通讯录同步`}
                  onChange={(v) => void 跑(`on-${s.源}`, () => 设通讯录同步(s.源, v), v ? `${s.名}通讯录同步已打开，${s.间隔分钟 === 30 ? "每半小时" : "每小时"}一次` : `${s.名}通讯录同步已关掉`)} />
                <Select size="small" style={{ width: 104 }} value={s.间隔分钟} options={间隔选项} disabled={!!忙} aria-label={`${s.名}同步频率`}
                  onChange={(v: 60 | 30) => void 跑(`gap-${s.源}`, () => 设通讯录间隔(s.源, v), `${s.名}通讯录改成${v === 30 ? "每半小时" : "每小时"}同步一次`)} />
                {s.凭据.齐了 ? <Tag color="success">凭据已填</Tag> : <Tag color="warning">凭据没填</Tag>}
                <Button size="small" loading={忙 === `sync-${s.源}`} disabled={!!忙 || !s.凭据.齐了} onClick={() => void 同步(s)}>立即同步</Button>
              </Space>

              {s.上次 && (
                <div style={{ marginTop: 8 }}>
                  <Tag color={结果色[s.上次.结果]}>{s.上次.结果}</Tag>
                  <span className="muted">{new Date(s.上次.时间).toLocaleString("zh-CN", { hour12: false })}　{s.上次.话}</span>
                  {!!s.上次.报告?.length && (
                    <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 20 }} data-testid={`org-sync-${s.源}-report`}>
                      {s.上次.报告.map((x, i) => <li key={i}>{x}</li>)}
                    </ul>
                  )}
                </div>
              )}

              <div style={{ display: "grid", gap: 8, marginTop: 12, maxWidth: 480 }}>
                {s.凭据.字段.map((f) => {
                  const v = 草稿[f.键];
                  const 提示 = f.来自环境变量 ? "用的是服务器环境变量" : f.密 && f.已填 ? `已填 ${f.值}，留空不改` : "";
                  const 框 = {
                    value: v ?? (f.密 ? "" : f.值),
                    placeholder: 提示 || f.名,
                    "aria-label": `${s.名} ${f.名}`,
                    autoComplete: "off",
                    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                      set凭据草稿((d) => ({ ...d, [s.源]: { ...(d[s.源] ?? {}), [f.键]: e.target.value } })),
                  };
                  return (
                    <label key={f.键} style={{ display: "grid", gap: 4 }}>
                      <span className="muted">{f.名}</span>
                      {f.密 ? <Input.Password {...框} visibilityToggle={false} /> : <Input {...框} />}
                    </label>
                  );
                })}
                <div>
                  <Button disabled={!改过凭据 || !!忙} loading={忙 === `cred-${s.源}`} onClick={() => void 存凭据(s)}>保存凭据</Button>
                </div>
              </div>

              {s.源 === "feishu" && <FeishuConnectCard 草稿={草稿} 初始={表概况} />}

              <div style={{ marginTop: 12 }}>
                <span className="muted">职务 → 业务角色（没对上的人，业务角色不动）</span>
                {s.职务们.length === 0 && <p className="muted" style={{ margin: "4px 0 0" }}>同步过一次以后，这里列出那边用到的职务。</p>}
                <div style={{ display: "grid", gap: 6, marginTop: 6, maxWidth: 480 }}>
                  {s.职务们.map((职务) => (
                    <Space key={职务} style={{ justifyContent: "space-between", width: "100%" }}>
                      <span>{职务}</span>
                      <Select size="small" style={{ width: 160 }} allowClear placeholder="不对" aria-label={`${职务} 对到的角色`}
                        value={s.角色对照[职务]} options={数据.角色们} disabled={!!忙}
                        onChange={(v: string | undefined) => {
                          const 新 = { ...s.角色对照 } as Record<string, string>;
                          if (v) 新[职务] = v;
                          else delete 新[职务];
                          void 跑(`map-${s.源}`, () => 设职务对照(s.源, 新), "职务对照已保存，下次同步生效");
                        }} />
                    </Space>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}
