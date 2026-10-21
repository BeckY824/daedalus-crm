"use client";

import { useMemo, useState } from "react";
import { RowLink } from "@/components/ui";
import { useRouter } from "next/navigation";
import { App, Alert, Button, Checkbox, Radio } from "antd";
import { smartTime } from "@/lib/utils";
import type { 疑似组 } from "@/lib/sync/dupes";
import { 合并重复动作, 撤销合并动作, 不是同一个人动作 } from "./team-actions";

/**
 * 设置 → 团队 →「疑似重复」（2026-10-20，用户定的是「合并成一份」，不是直接删）。只给老板和业务主管（读团队状态里业务员拿到的是空的）。
 *
 * 每组列出几份的对比：负责人、跟进条数、最近一次跟进、建档时间；默认留跟进多的那份，一样多留先建的，每组都能改选。
 * 顶上「全选 / 批量合并」，每组也能单独合并或标「不是同一个人」（标了以后全队都不再列）。
 * 合并前自动备份一份；合并后能撤销一次（lib/customer-merge.ts）。供应商那一类照旧只列出来、给链接
 */
export default function DupeMergeCard({ 组们, 上次合并, 叫法, 变了 }: {
  组们: 疑似组[];
  上次合并: { at: string; 对数: number } | null;
  叫法: string;
  变了: () => Promise<void>;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const 客户组 = useMemo(() => 组们.filter((g) => g.种类 === "客户"), [组们]);
  const 供应商组 = 组们.filter((g) => g.种类 === "供应商");
  const 键 = (g: 疑似组) => `${g.种类}${g.依据}`;
  const [留, set留] = useState<Record<string, string>>({});
  const [选, set选] = useState<Set<string>>(new Set());
  const [忙, set忙] = useState(false);
  const 留哪个 = (g: 疑似组) => 留[键(g)] ?? g.留 ?? g.记录[0].id;
  const 选中的 = 客户组.filter((g) => 选.has(键(g)));
  const 全选了 = 客户组.length > 0 && 选中的.length === 客户组.length;

  const 对们 = (gs: 疑似组[]) => gs.flatMap((g) => g.记录.filter((r) => r.id !== 留哪个(g)).map((r) => ({ 留: 留哪个(g), 并: r.id })));

  async function 收尾() {
    set选(new Set());
    set留({});
    await 变了();
    router.refresh();
  }

  function 合并(gs: 疑似组[]) {
    const 对 = 对们(gs);
    if (!对.length) return;
    const 一组 = gs.length === 1 ? gs[0] : null;
    const 留下 = 一组 ? 一组.记录.find((r) => r.id === 留哪个(一组)) : null;
    modal.confirm({
      title: 一组 ? `合并成一份，留下「${留下?.name}」（${留下?.谁的 ?? "—"}）？` : `合并 ${gs.length} 组疑似重复？`,
      content: (
        <div data-testid="dupe-merge-confirm">
          <p>每组留下选中的那份，另一份的跟进、商机、签约、联系人、待办、计划都挪过来，空着的资料用它补上（已经有的不改），然后删掉多出来的那份。负责人还是留下那份的负责人。</p>
          <p className="muted">合并前会自动备份一份（设置 → 数据 → 自动备份 →「合并前」）；合并完能撤销一次。会同步给全队，各台电脑上都变成一份。</p>
        </div>
      ),
      okText: 一组 ? "合并" : `合并 ${gs.length} 组`,
      cancelText: "取消",
      async onOk() {
        if (忙) return;
        set忙(true);
        const r = await 合并重复动作(对);
        set忙(false);
        if (!r.ok) return void message.error(r.error);
        if (r.没合.length) message.warning(`合并了 ${r.合了} 对，${r.没合.length} 对没合：${r.没合[0]}`, 6);
        else message.success(`合并好了：${r.合了} 对变成一份。合并前已备份，不对的话点「撤销这次合并」`, 5);
        await 收尾();
      },
    });
  }

  function 不是(g: 疑似组) {
    modal.confirm({
      title: "这几位不是同一个人？",
      content: <p>{g.记录.map((r) => `「${r.name}」`).join("、")}以后不再列在疑似重复里（全队都不列）。之后又有同号码的新${叫法}进来，会再列出来。</p>,
      okText: "不是同一个人",
      cancelText: "取消",
      async onOk() {
        const r = await 不是同一个人动作(g.记录.map((x) => x.id), g.记录.map((x) => x.name));
        if (!r.ok) return void message.error(r.error);
        message.success("记下了，不再列出来");
        await 收尾();
      },
    });
  }

  function 撤销() {
    modal.confirm({
      title: "撤销上一次合并？",
      content: <p>被合并的那几份按原样建回来，挪过去的跟进、商机……挪回去，补上的空格清回空。合并之后又改过的不动。只能撤这一次。</p>,
      okText: "撤销合并",
      cancelText: "取消",
      async onOk() {
        const r = await 撤销合并动作();
        if (!r.ok) return void message.error(r.error);
        if (r.没撤.length) message.warning(`撤回了 ${r.撤了} 对，${r.没撤.length} 对撤不了：${r.没撤[0]}`, 6);
        else message.success(`撤销好了：${r.撤了} 对拆回两份`);
        await 收尾();
      },
    });
  }

  if (!组们.length && !上次合并) return null;
  return (
    <section className="team-card" data-testid="team-dupes">
      <h3>疑似重复 {组们.length}</h3>
      <p className="muted">
        两个人各录了同一位{叫法}时会出现在这里。合并成一份：留下选中的那份，另一份的跟进、商机、签约都挪过来，空着的资料用它补上，然后删掉多的那份。
        号码一样不一定是同一个人，不是的标一下，以后不再列。
      </p>
      {上次合并 && (
        <Alert
          className="dupe-undo" type="info" showIcon data-testid="dupe-undo"
          message={`${smartTime(上次合并.at)} 合并了 ${上次合并.对数} 对。合并前的数据有备份，可以撤销一次`}
          action={<Button size="small" onClick={撤销}>撤销这次合并</Button>}
        />
      )}
      {客户组.length > 0 && (
        <div className="dupe-bar">
          <Checkbox
            checked={全选了} indeterminate={!全选了 && 选中的.length > 0}
            onChange={(e) => set选(e.target.checked ? new Set(客户组.map(键)) : new Set())}
          >全选</Checkbox>
          <Button type="primary" size="small" disabled={!选中的.length} loading={忙} onClick={() => 合并(选中的)} data-testid="dupe-merge-selected">
            批量合并{选中的.length ? `（${选中的.length} 组）` : ""}
          </Button>
        </div>
      )}
      <ul className="dupe-groups">
        {客户组.map((g) => (
          <li key={键(g)} className="dupe-group" data-testid="dupe-group">
            <div className="dupe-group-head">
              <Checkbox
                checked={选.has(键(g))}
                onChange={(e) => set选((x) => { const n = new Set(x); if (e.target.checked) n.add(键(g)); else n.delete(键(g)); return n; })}
                aria-label={`选中 ${g.依据}`}
              />
              <span className="dupe-basis">{g.依据}</span>
              <span className="dupe-actions">
                <Button size="small" onClick={() => 合并([g])} disabled={忙}>合并</Button>
                <Button size="small" type="link" onClick={() => 不是(g)}>不是同一个人</Button>
              </span>
            </div>
            <div className="dupe-compare-wrap">
              <table className="dupe-compare">
                <thead>
                  <tr><th>留下</th><th>{叫法}</th><th>负责人</th><th>跟进</th><th>最近跟进</th><th>建档</th></tr>
                </thead>
                <tbody>
                  {g.记录.map((r) => (
                    <tr key={r.id} className={留哪个(g) === r.id ? "is-keep" : undefined}>
                      <td><Radio checked={留哪个(g) === r.id} onChange={() => set留((x) => ({ ...x, [键(g)]: r.id }))} aria-label={`留下 ${r.name}`} /></td>
                      <td className="dupe-name"><RowLink href={r.href}>{r.name}</RowLink></td>
                      <td className="dupe-owner">{r.谁的 ?? "—"}</td>
                      <td>{r.跟进 ?? 0} 条</td>
                      <td>{r.最近跟进 ? smartTime(r.最近跟进) : <span className="muted">没有</span>}</td>
                      <td>{r.建档 ? r.建档.slice(0, 10) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </li>
        ))}
      </ul>
      {供应商组.length > 0 && (
        <ul className="team-dupes">
          {供应商组.map((g) => (
            <li key={键(g)}>
              <span className="muted">{g.种类} · {g.依据}：</span>
              {g.记录.map((r, i) => (
                <span key={r.id}>{i > 0 && "、"}<RowLink href={r.href}>{r.name}</RowLink></span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
