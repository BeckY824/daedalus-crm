"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Input, InputNumber, Popconfirm, Radio, Select, Space, Switch, Tag } from "antd";
import { 加组员角色, 改组员角色, 加项目异常类别, 改项目异常类别, 改组织规则, 预览超时回收 } from "@/app/(app)/projects/actions";
import { 上限最大, 时长最大, 推进权限们, type 推进权限, type 组织规则, type 规则改动 } from "@/lib/project/org-rules";
// 这两张卡（超时回收、节点推进）只在企业版出现（组织规则 只有企业版才读），节点按企业版字典列
import { 企业版字典, 本套节点名, 出口叫法上限 } from "@/lib/project/stage-dict";
import { 必填项们, 必填叫法, 能配必填的节点, 建议必填 } from "@/lib/project/required";

const 节点们 = 企业版字典.节点们;
const 默认天数 = 企业版字典.默认超时天数;

type 字典项 = { id: string; name: string; active: boolean; 用的人: number };
type 结果 = Promise<{ ok: boolean; error?: string }>;

export type 项目设置 = {
  角色们: 字典项[];
  /** 进异常状态时选的类别；用的人 = 现在停在这个类别上的项目数 */
  类别们: 字典项[];
  /** 企业版组织规则，每条默认关；不是企业版 = null，卡片不出（服务端读的 企业版()） */
  组织规则: 组织规则 | null;
  /** 每人手上线索 / 商机阶段的项目数（userId → 个数），算持有上限的口径 */
  持有: Record<string, number>;
  /**
   * 每张卡这个人能不能改：null = 能改，否则是「只有……能改」那句（服务端按「后台设置谁能改」算好，
   * 不是企业版只有老板能改；共享试用区谁都不能改）
   */
  挡: Record<"字典" | "持有上限" | "节点时限" | "必填字段" | "阶段规则", string | null>;
};

/**
 * 设置里的「项目模式」一栏（开关开着才有）：项目组员的角色字典、异常类别字典，企业版再加组织规则；谁能改看 value.挡，别人只看。
 * 成员的上级归部门编制管，不在这里
 */
export default function ProjectSettingsTab({ value, 成员 }: { value: 项目设置; 成员: { id: string; name: string }[] }) {
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
        项们={value.角色们} 挡={value.挡.字典} 忙={忙} 跑={跑} 加={加组员角色} 改={改组员角色}
      />
      <DictCard
        title="异常类别" 叫法="类别" 用的说法="个项目停在这个类别" 新的提示="新类别，比如：客户失联"
        说明="项目标成异常状态时选一个类别，备注可以不写。停用的类别不能再选，已经停在这个类别上的项目照样显示。"
        停用说明="停用后不能再选；已经用着它的项目不变"
        项们={value.类别们} 挡={value.挡.字典} 忙={忙} 跑={跑} 加={加项目异常类别} 改={改项目异常类别}
      />
      {value.组织规则 && <HoldCapCard 规则={value.组织规则.公海} 持有={value.持有} 成员={成员} 挡={value.挡.持有上限} 忙={忙} 跑={跑} />}
      {value.组织规则 && <TimeoutCard 规则={value.组织规则.超时回收} 挡={value.挡.节点时限} 忙={忙} 跑={跑} />}
      {value.组织规则 && <AdvanceCard 规则={value.组织规则.节点推进} 挡={value.挡.必填字段} 忙={忙} 跑={跑} />}
      {value.组织规则 && <StageRuleCard 规则={value.组织规则.阶段} 挡={value.挡.阶段规则} 忙={忙} 跑={跑} />}
    </div>
  );
}

/** 一张字典卡：列出每一项，能改的人（看卡片右上角）改名、停用 / 启用、加新的；只停用不删，用过的照样认 */
function DictCard({
  title, 叫法, 用的说法, 新的提示, 说明, 停用说明, 项们, 挡, 忙, 跑, 加, 改,
}: {
  title: string; 叫法: string; 用的说法: string; 新的提示: string; 说明: string; 停用说明: string;
  项们: 字典项[]; 挡: string | null; 忙: boolean;
  跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
  加: (name: string) => 结果;
  改: (id: string, patch: { name?: string; active?: boolean }) => 结果;
}) {
  const [新的, set新的] = useState("");
  const [改名中, set改名中] = useState<{ id: string; name: string } | null>(null);
  const 加上 = async () => 新的.trim() && (await 跑(() => 加(新的), "已加上")) && set新的("");
  const 改名 = async () => 改名中 && (await 跑(() => 改(改名中.id, { name: 改名中.name }), "已改名")) && set改名中(null);

  return (
    <Card title={title} extra={挡 && <span style={{ color: "var(--text-muted)" }}>{挡}</span>}>
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
              {!挡 && (
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
      {!挡 && (
        <Space.Compact style={{ width: "100%", marginTop: 4 }}>
          <Input placeholder={新的提示} aria-label={`新${叫法}名`} maxLength={20} value={新的} onChange={(e) => set新的(e.target.value)} onPressEnter={() => void 加上()} />
          <Button disabled={忙 || !新的.trim()} onClick={() => void 加上()}>加上</Button>
        </Space.Compact>
      )}
    </Card>
  );
}

/**
 * 项目持有上限（企业版组织规则，默认关）：开了以后每人手上线索 / 商机阶段的项目到了上限，就领不了公海、也不能再被指派。
 * 自己建档、跟着客户转、离职交接不拦。每人可以单独设，空着 = 用默认
 */
function HoldCapCard({
  规则, 持有, 成员, 挡, 忙, 跑,
}: {
  规则: 组织规则["公海"]; 持有: Record<string, number>; 成员: { id: string; name: string }[];
  挡: string | null; 忙: boolean; 跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
}) {
  const [默认, set默认] = useState<number | null>(规则.默认上限);
  const [每人, set每人] = useState<Record<string, number | null>>(规则.每人上限);
  const 改了 = 默认 !== 规则.默认上限 || 成员.some((u) => (每人[u.id] ?? null) !== (规则.每人上限[u.id] ?? null));
  const 保存 = () => 跑(() => 改组织规则({ 公海: { 默认上限: 默认 ?? undefined, 每人上限: 每人 } }), "已保存");

  return (
    <Card
      title="项目持有上限"
      extra={
        <Space>
          {挡 && <span style={{ color: "var(--text-muted)" }}>{挡}</span>}
          <Switch
            aria-label="项目持有上限"
            checked={规则.持有上限开}
            disabled={!!挡 || 忙}
            onChange={(开) => void 跑(() => 改组织规则({ 公海: { 持有上限开: 开 } }), 开 ? "已开持有上限" : "已关持有上限")}
          />
        </Space>
      }
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>
        开了以后，每人手上线索 / 商机阶段、还在跟的项目到了上限，就不能再从项目公海领、也不能再被指派新项目；自己建档的不拦。默认关，不限个数。
      </div>
      {规则.持有上限开 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <span>默认每人最多</span>
            <InputNumber aria-label="默认持有上限" min={1} max={上限最大} precision={0} suffix="个" style={{ width: 120 }} disabled={!!挡} value={默认} onChange={(v) => set默认(v)} />
          </div>
          {成员.map((u) => (
            <div key={u.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
              <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.name}>{u.name}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 12, flex: "0 0 auto" }}>手上 {持有[u.id] ?? 0} 个</span>
              <InputNumber
                aria-label={`${u.name}的持有上限`}
                min={0} max={上限最大} precision={0} suffix="个" style={{ width: 120, flex: "0 0 auto" }}
                placeholder={`默认 ${默认 ?? 规则.默认上限}`}
                disabled={!!挡}
                value={每人[u.id] ?? null}
                onChange={(v) => set每人((m) => ({ ...m, [u.id]: v }))}
              />
            </div>
          ))}
          {!挡 && (
            <Button type="primary" style={{ marginTop: 4 }} disabled={忙 || !改了 || 默认 === null} onClick={() => void 保存()}>保存</Button>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * 超时回收（企业版组织规则，默认关）：线索、商机阶段按节点设最长处理天数，超过还没跟进的项目自动回到项目公海、负责人收到提醒。
 * 没设天数的节点按默认天数（企业版字典，7 天）回收；订单阶段不回收。开了以后在项目上记沟通要填下一步时间。
 * 保存前先按新设置数一遍「现在会回收几个」，有的话让老板确认
 */
function TimeoutCard({
  规则, 挡, 忙, 跑,
}: {
  规则: 组织规则["超时回收"]; 挡: string | null; 忙: boolean;
  跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
}) {
  const { message, modal } = App.useApp();
  const [天数, set天数] = useState<Record<string, number | null>>(规则.节点天数);
  const 节点 = [...节点们.线索, ...节点们.商机];
  const 改了 = 节点.some((n) => (天数[n] ?? null) !== (规则.节点天数[n] ?? null));

  /** 先数会回收几个，有就确认；改完提示真收了几个 */
  const 确认后存 = async (改: 规则改动, 成了: string) => {
    const 看 = await 预览超时回收(改).catch(() => null);
    if (!看) return void message.error("没改成，请稍后再试");
    if (!看.ok) return void message.error(看.error ?? "没改成，请稍后再试");
    const 存 = () => 跑(async () => {
      const r = await 改组织规则(改);
      if (r.ok) message.success(r.收回 ? `${成了}，${r.收回} 个项目回到了项目公海` : 成了);
      return r;
    });
    if (!看.个数) return void (await 存());
    modal.confirm({
      title: `按新设置，现在会有 ${看.个数} 个项目回到项目公海`,
      content: 看.团队
        ? "这些项目在节点上已经超过处理时长没跟进。确认后你名下的马上回到公海；别人名下的在他下次打开首页或项目列表时回到公海。负责人都会收到提醒。"
        : "这些项目在节点上已经超过处理时长没跟进。确认后它们马上回到公海，负责人会收到提醒。",
      okText: "确认保存",
      cancelText: "再想想",
      onOk: () => void 存(),
    });
  };

  return (
    <Card
      title="超时回收"
      extra={
        <Space>
          {挡 && <span style={{ color: "var(--text-muted)" }}>{挡}</span>}
          <Switch
            aria-label="超时回收"
            checked={规则.开}
            disabled={!!挡 || 忙}
            onChange={(开) => void (开 ? 确认后存({ 超时回收: { 开 } }, "已开超时回收") : 跑(() => 改组织规则({ 超时回收: { 开 } }), "已关超时回收"))}
          />
        </Space>
      }
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>
        开了以后，线索、商机阶段的项目在一个节点上超过处理时长还没跟进，自动回到项目公海，负责人会收到提醒；记沟通时填了下一步时间的，过了那天还没跟进也会回收。项目上记沟通要填下一步时间。{默认天数 ? `没填天数的节点按 ${默认天数} 天算` : "没填天数的节点不回收"}，订单阶段不回收。默认关。
      </div>
      {规则.开 && (
        <>
          {(["线索", "商机"] as const).map((阶段) => (
            <div key={阶段} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 500, marginBottom: 8 }}>{阶段}阶段</div>
              {节点们[阶段].map((n) => (
                <div key={n} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0 }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={n}>{n}</span>
                  <InputNumber
                    aria-label={`「${n}」的处理时长`}
                    min={1} max={时长最大} precision={0} suffix="天" style={{ width: 120, flex: "0 0 auto" }}
                    placeholder={默认天数 ? `默认 ${默认天数} 天` : "不回收"}
                    disabled={!!挡}
                    value={天数[n] ?? null}
                    onChange={(v) => set天数((m) => ({ ...m, [n]: v }))}
                  />
                </div>
              ))}
            </div>
          ))}
          {!挡 && (
            <Button type="primary" style={{ marginTop: 4 }} disabled={忙 || !改了} onClick={() => void 确认后存({ 超时回收: { 节点天数: 天数 } }, "已保存")}>保存</Button>
          )}
        </>
      )}
    </Card>
  );
}

const 必填选项 = 必填项们.map((x) => ({ value: x.key, label: 必填叫法(x.key), title: x.说明 }));
const 同一份 = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 节点推进（企业版组织规则，默认关）：老板给节点配「必填哪几样」，项目在这个节点上填齐了自动推到下一节点。
 * 配了必填的节点，手动往前推只给老板、主管；没配的节点照原来手动推。最后一个节点由人点成功交付，不能配。
 * 改了清单不当场推：项目下次保存（改项目、记沟通、改客户资料）时按新清单走
 */
function AdvanceCard({
  规则, 挡, 忙, 跑,
}: {
  规则: 组织规则["节点推进"]; 挡: string | null; 忙: boolean;
  跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
}) {
  const [必填, set必填] = useState<Record<string, string[]>>(规则.必填);
  const 改了 = 能配必填的节点.some((n) => !同一份(必填[n], 规则.必填[n]));
  const 阶段们 = (["线索", "商机", "订单"] as const).map((阶段) => ({ 阶段, 节点: 节点们[阶段].filter((n) => 能配必填的节点.includes(n)) }));

  return (
    <Card
      title="节点推进"
      extra={
        <Space>
          {挡 && <span style={{ color: "var(--text-muted)" }}>{挡}</span>}
          <Switch
            aria-label="节点推进"
            checked={规则.开}
            disabled={!!挡 || 忙}
            onChange={(开) => void 跑(() => 改组织规则({ 节点推进: { 开 } }), 开 ? "已开节点推进" : "已关节点推进")}
          />
        </Space>
      }
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>
        开了以后，给节点配上必填的几样，项目在这个节点上填齐了自动推到下一个节点，节点变更里记一行「必填齐了，自动推进」。没填齐也能保存，项目页上会列出还差哪几样。配了必填的节点，手动往前推只有老板、主管能点，往后退照旧；没配的节点照原来手动推。改了清单以后，项目下次保存时按新清单走。默认关。
      </div>
      {规则.开 && (
        <>
          {阶段们.map(({ 阶段, 节点 }) => (
            <div key={阶段} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 500, marginBottom: 8 }}>{阶段}阶段</div>
              {节点.map((n) => (
                <div key={n} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0, flexWrap: "wrap" }}>
                  <span style={{ flex: "0 0 96px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={n}>{n}</span>
                  <Select
                    aria-label={`「${n}」的必填`}
                    mode="multiple"
                    allowClear
                    style={{ flex: "1 1 240px", minWidth: 0 }}
                    placeholder="不配，照原来手动推"
                    disabled={!!挡}
                    options={必填选项}
                    value={必填[n] ?? []}
                    onChange={(v: string[]) => set必填((m) => ({ ...m, [n]: v }))}
                  />
                </div>
              ))}
            </div>
          ))}
          {!挡 && (
            <Space wrap style={{ marginTop: 4 }}>
              <Button type="primary" disabled={忙 || !改了} onClick={() => void 跑(() => 改组织规则({ 节点推进: { 必填 } }), "已保存")}>保存</Button>
              <Button disabled={忙} onClick={() => set必填(Object.fromEntries(Object.entries(建议必填).map(([n, v]) => [本套节点名(n, 企业版字典), v])))}>用建议清单</Button>
            </Space>
          )}
        </>
      )}
    </Card>
  );
}

const 推进权限说明: Record<推进权限, string> = {
  负责人可推: "负责人自己、直属上级、老板、总管理员都能往前推",
  仅上级推: "负责人有直属上级时，只有直属上级、老板、总管理员能往前推",
};

/**
 * 阶段规则（企业版，10-26 会定）：往前推节点谁能推（默认负责人可推），线索、商机两个阶段出口的叫法。
 * 改叫法只换说法：存的结局、节点、跨阶段单向的规矩都不变。往后退、点结局不归推进权限管。每次推进都记在节点变更里
 */
function StageRuleCard({
  规则, 挡, 忙, 跑,
}: {
  规则: 组织规则["阶段"]; 挡: string | null; 忙: boolean;
  跑: (f: () => 结果, 成了?: string) => Promise<boolean>;
}) {
  const 阶段们 = ["线索", "商机"] as const;
  const 原来 = (s: (typeof 阶段们)[number]): [string, string] => [规则.出口叫法[s]?.[0] ?? "", 规则.出口叫法[s]?.[1] ?? ""];
  const [叫法, set叫法] = useState<Record<string, [string, string]>>(() => Object.fromEntries(阶段们.map((s) => [s, 原来(s)])));
  const 改了 = 阶段们.some((s) => 叫法[s][0] !== 原来(s)[0] || 叫法[s][1] !== 原来(s)[1]);
  const 存 = () => 跑(() => 改组织规则({
    阶段: { 出口叫法: Object.fromEntries(阶段们.map((s) => [s, [叫法[s][0].trim() || null, 叫法[s][1].trim() || null] as const])) },
  }), "已保存");

  return (
    <Card title="阶段规则" extra={挡 && <span style={{ color: "var(--text-muted)" }}>{挡}</span>}>
      <div style={{ color: "var(--text-muted)", marginBottom: 12 }}>
        线索阶段只能走到「转商机」或「流失」，商机阶段只能「赢单」或「丢单」，订单只能从商机进；进了下一个阶段就退不回上一个，阶段里面往后退随便退。每次推进都记在节点变更里。
      </div>
      <div style={{ fontWeight: 500, marginBottom: 8 }}>谁能往前推节点</div>
      <Radio.Group
        aria-label="往前推权限"
        disabled={!!挡 || 忙}
        value={规则.推进权限}
        onChange={(e) => void 跑(() => 改组织规则({ 阶段: { 推进权限: e.target.value as 推进权限 } }), "已保存")}
        style={{ display: "grid", gap: 4, marginBottom: 16 }}
        options={推进权限们.map((v) => ({ value: v, label: <span>{v}<span style={{ color: "var(--text-muted)" }}>：{推进权限说明[v]}</span></span> }))}
      />
      <div style={{ fontWeight: 500, marginBottom: 8 }}>出口叫法<span style={{ color: "var(--text-muted)", fontWeight: 400 }}>（空着 = 用默认；只换说法，已经定了结果的项目不变）</span></div>
      {阶段们.map((s) => {
        const [成, 没成] = 企业版字典.出口们[s];
        return (
          <div key={s} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, minWidth: 0, flexWrap: "wrap" }}>
            <span style={{ flex: "0 0 64px" }}>{s}阶段</span>
            {([0, 1] as const).map((i) => (
              <Input
                key={i}
                aria-label={`${s}阶段${i === 0 ? "走成" : "没走成"}的叫法`}
                style={{ flex: "1 1 140px", minWidth: 0 }}
                maxLength={出口叫法上限}
                placeholder={(i === 0 ? 成 : 没成).叫法}
                disabled={!!挡}
                value={叫法[s][i]}
                onChange={(e) => set叫法((m) => {
                  const v: [string, string] = [...m[s]];
                  v[i] = e.target.value;
                  return { ...m, [s]: v };
                })}
              />
            ))}
          </div>
        );
      })}
      {!挡 && <Button type="primary" style={{ marginTop: 4 }} disabled={忙 || !改了} onClick={() => void 存()}>保存叫法</Button>}
    </Card>
  );
}
