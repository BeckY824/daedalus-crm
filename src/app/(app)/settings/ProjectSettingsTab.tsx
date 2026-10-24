"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, Popconfirm, Space, Tag } from "antd";
import { 加组员角色, 改组员角色, 加项目异常类别, 改项目异常类别 } from "@/app/(app)/projects/actions";

type 字典项 = { id: string; name: string; active: boolean; 用的人: number };
type 结果 = Promise<{ ok: boolean; error?: string }>;

export type 项目设置 = {
  角色们: 字典项[];
  /** 进异常状态时选的类别；用的人 = 现在停在这个类别上的项目数 */
  类别们: 字典项[];
};

/**
 * 设置里的「项目模式」一栏（开关开着才有）：项目组员的角色字典、异常类别字典，只有老板能改，其他人只看。
 * 成员的上级归部门编制管，不在这里
 */
export default function ProjectSettingsTab({ value, isAdmin }: { value: 项目设置; isAdmin: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [忙, set忙] = useState(false);

  const 跑 = async (f: () => 结果, 成了?: string) => {
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

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <DictCard
        title="项目组员角色" 叫法="角色" 用的说法="位组员在用" 新的提示="新角色，比如：技术负责人"
        说明="拉人进项目组时给他选一个角色。停用的角色不能再选，已经用着它的组员不受影响。"
        停用说明="停用后不能再选；已经用着它的组员不变"
        项们={value.角色们} isAdmin={isAdmin} 忙={忙} 跑={跑} 加={加组员角色} 改={改组员角色}
      />
      <DictCard
        title="异常类别" 叫法="类别" 用的说法="个项目停在这个类别" 新的提示="新类别，比如：客户失联"
        说明="项目标成异常状态时选一个类别，备注可以不写。停用的类别不能再选，已经停在这个类别上的项目照样显示。"
        停用说明="停用后不能再选；已经用着它的项目不变"
        项们={value.类别们} isAdmin={isAdmin} 忙={忙} 跑={跑} 加={加项目异常类别} 改={改项目异常类别}
      />
    </div>
  );
}

/** 一张字典卡：列出每一项，老板能改名、停用 / 启用、加新的；只停用不删，用过的照样认 */
function DictCard({
  title, 叫法, 用的说法, 新的提示, 说明, 停用说明, 项们, isAdmin, 忙, 跑, 加, 改,
}: {
  title: string; 叫法: string; 用的说法: string; 新的提示: string; 说明: string; 停用说明: string;
  项们: 字典项[]; isAdmin: boolean; 忙: boolean;
  跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
  加: (name: string) => 结果;
  改: (id: string, patch: { name?: string; active?: boolean }) => 结果;
}) {
  const [新的, set新的] = useState("");
  const [改名中, set改名中] = useState<{ id: string; name: string } | null>(null);
  const 加上 = async () => 新的.trim() && (await 跑(() => 加(新的), "已加上")) && set新的("");
  const 改名 = async () => 改名中 && (await 跑(() => 改(改名中.id, { name: 改名中.name }), "已改名")) && set改名中(null);

  return (
    <Card title={title} extra={!isAdmin && <span style={{ color: "var(--text-muted)" }}>只有老板能改</span>}>
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>{说明}</div>
      {项们.length === 0 && <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>还没有{叫法}</div>}
      {项们.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
          {改名中?.id === r.id ? (
            <Space.Compact style={{ flex: "1 1 auto", minWidth: 0 }}>
              <Input
                autoFocus
                maxLength={20}
                aria-label={`「${r.name}」的新名字`}
                value={改名中.name}
                onChange={(e) => set改名中({ id: r.id, name: e.target.value })}
                onPressEnter={() => void 改名()}
              />
              <Button type="primary" disabled={忙 || !改名中.name.trim()} onClick={() => void 改名()}>保存</Button>
              <Button onClick={() => set改名中(null)}>取消</Button>
            </Space.Compact>
          ) : (
            <>
              <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: r.active ? undefined : "var(--text-muted)" }} title={r.name}>{r.name}</span>
              {!r.active && <Tag>已停用</Tag>}
              {r.用的人 > 0 && <span style={{ color: "var(--text-muted)", fontSize: 12, flex: "0 0 auto" }}>{r.用的人} {用的说法}</span>}
              {isAdmin && (
                <>
                  <Button size="small" type="text" disabled={忙} onClick={() => set改名中({ id: r.id, name: r.name })}>改名</Button>
                  {r.active ? (
                    <Popconfirm title={`停用「${r.name}」？`} description={停用说明} okText="停用" onConfirm={() => void 跑(() => 改(r.id, { active: false }), "已停用")}>
                      <Button size="small" type="text" disabled={忙}>停用</Button>
                    </Popconfirm>
                  ) : (
                    <Button size="small" type="text" disabled={忙} onClick={() => void 跑(() => 改(r.id, { active: true }), "已启用")}>启用</Button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      ))}
      {isAdmin && (
        <Space.Compact style={{ width: "100%", marginTop: 4 }}>
          <Input placeholder={新的提示} aria-label={`新${叫法}名`} maxLength={20} value={新的} onChange={(e) => set新的(e.target.value)} onPressEnter={() => void 加上()} />
          <Button disabled={忙 || !新的.trim()} onClick={() => void 加上()}>加上</Button>
        </Space.Compact>
      )}
    </Card>
  );
}
