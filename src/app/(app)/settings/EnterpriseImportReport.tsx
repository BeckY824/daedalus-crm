"use client";

import { useMemo, useState } from "react";
import { App, Alert, Button, Collapse, Popconfirm, Progress, Select, Space, Table, Tag, Typography } from "antd";
import { 实体名, 实体顺序, 标准字段, 字段中文, type 实体, type 问题, type 值对照名 } from "@/lib/enterprise-import/types";
import type { 试跑报告, 映射改动, 报告列 } from "@/lib/enterprise-import/report";
import { 改映射重新试跑, 丢掉试跑, 正式导入一段, type 企业版概况 } from "./enterprise-import-actions";

/**
 * 企业版导入的试跑报告：看清这次会写多少、哪些跳过、映射认得对不对；改了映射重新试跑；确认后正式导入。
 *
 * 报告是服务端试跑存下的那一份（report.ts 的 试跑报告），这里只摆和收集改动。
 * 改动先攒在本地（映射改动），点「按改的重新试跑」一次交上去：重新试跑不再问 AI，人改的标「手动」。
 * 正式导入一段一段调（每段 20 秒左右），进度条照 写到 / 总数 走，中途关掉页面也不丢——批次列表里点「接着导入」。
 */

/** 列落到「进备注」：清洗那边认这个特殊值（clean.ts），和标准字段不重名 */
const 进备注 = "+remark";

const 说明色: Record<string, string> = { 规则: "default", AI: "purple", 手动: "blue" };

const 错话 = (e: unknown) => (e instanceof Error ? e.message : "没成功，请重试");

export default function EnterpriseImportReport({
  批次Id,
  报告,
  只读 = false,
  概况,
  on改了,
  on完了,
}: {
  批次Id: string;
  报告: 试跑报告;
  /** 已经开始导入 / 导完的批次回头看报告：不给改、不给导 */
  只读?: boolean;
  概况: Pick<企业版概况, "成员们" | "合法值们">;
  /** 重新试跑后的新报告 */
  on改了: (r: 试跑报告) => void;
  /** 导完了、或者丢掉了：回到列表 */
  on完了: () => void;
}) {
  const { message, modal } = App.useApp();
  const [改, set改] = useState<映射改动>({});
  const [忙, set忙] = useState<"重跑" | "导入" | "丢掉" | null>(null);
  const [进度, set进度] = useState<{ 写到: number; 总数: number } | null>(null);

  const 改了几处 = useMemo(
    () =>
      Object.keys(改.文件实体 ?? {}).length +
      Object.values(改.列 ?? {}).reduce((n, x) => n + Object.keys(x ?? {}).length, 0) +
      Object.values(改.值 ?? {}).reduce((n, x) => n + Object.keys(x ?? {}).length, 0) +
      Object.keys(改.负责人 ?? {}).length +
      (改.默认负责人Id !== undefined ? 1 : 0),
    [改],
  );

  const 成员选项 = useMemo(() => 概况.成员们.map((u) => ({ value: u.id, label: u.name })), [概况.成员们]);

  async function 重跑() {
    set忙("重跑");
    try {
      const r = await 改映射重新试跑(批次Id, 改);
      set改({});
      on改了(r);
      message.success("已按改的重新试跑");
    } catch (e) {
      message.error(错话(e));
    } finally {
      set忙(null);
    }
  }

  async function 导入() {
    set忙("导入");
    set进度({ 写到: 0, 总数: 报告.合计.待写 });
    try {
      for (;;) {
        const r = await 正式导入一段(批次Id);
        set进度({ 写到: r.写到, 总数: r.总数 });
        if (r.完了) {
          modal.success({
            title: "导入完成",
            content: `新建 ${r.新建}，更新 ${r.更新}，跳过 ${r.跳过}${r.冲突 ? `，${r.冲突} 条和我们这边改过的冲突，等人定` : ""}${r.失败 ? `，${r.失败} 条没写进去（批次列表里展开能看原因）` : ""}。整批可以撤回。`,
          });
          on完了();
          return;
        }
        // 别处在写同一批（两个人同时点了导入）：它会写完，这边不抢
        if (r.状态 !== "applying") {
          message.info("这一批别处正在导入，到批次列表里看进度");
          on完了();
          return;
        }
      }
    } catch (e) {
      message.error(`${错话(e)}。已写进去的留着，到批次列表里点「接着导入」`);
    } finally {
      set忙(null);
      set进度(null);
    }
  }

  async function 丢掉() {
    set忙("丢掉");
    try {
      await 丢掉试跑(批次Id);
      on完了();
    } catch (e) {
      message.error(错话(e));
    } finally {
      set忙(null);
    }
  }

  const 改列 = (e: 实体, 表头: string, 字段: string) => set改((x) => ({ ...x, 列: { ...x.列, [e]: { ...x.列?.[e], [表头]: 字段 } } }));
  const 改值 = (名: 值对照名, 原值: string, 值: string) => set改((x) => ({ ...x, 值: { ...x.值, [名]: { ...x.值?.[名], [原值]: 值 } } }));
  const 改人 = (写法: string, id: string) => set改((x) => ({ ...x, 负责人: { ...x.负责人, [写法]: id } }));

  const 列表格 = (e: 实体, 列们: 报告列[]) => {
    const 选项 = [
      ...标准字段[e].map((f) => ({ value: f, label: 字段中文[f] ?? f })),
      { value: 进备注, label: e === "followup" ? "拼进内容" : "拼进备注" },
      { value: "", label: "不用" },
    ];
    return (
      <Table<报告列>
        key={e}
        rowKey="表头"
        size="small"
        pagination={false}
        dataSource={列们}
        title={() => <b>{实体名[e]}</b>}
        columns={[
          { title: "原系统的列", dataIndex: "表头", width: 180 },
          {
            title: "落到我们的",
            width: 200,
            render: (_, c) => (
              <Select
                size="small"
                style={{ width: 180 }}
                disabled={只读}
                value={改.列?.[e]?.[c.表头] ?? c.字段}
                options={选项}
                onChange={(v) => 改列(e, c.表头, v)}
              />
            ),
          },
          { title: "谁认的", width: 80, render: (_, c) => (改.列?.[e]?.[c.表头] !== undefined ? <Tag color="blue">手动</Tag> : c.说明 ? <Tag color={说明色[c.说明]}>{c.说明}</Tag> : null) },
          { title: "样例", render: (_, c) => <Typography.Text type="secondary" ellipsis>{c.样例.filter(Boolean).slice(0, 3).join(" / ") || "—"}</Typography.Text> },
        ]}
      />
    );
  };

  const 要选类别 = 报告.文件.filter((f) => !f.实体);

  return (
    <Space orientation="vertical" size={14} style={{ display: "flex" }}>
      {报告.提醒.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="这次试跑要你看一眼的"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {报告.提醒.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          }
        />
      )}

      {报告.文件.length > 0 && (
        <Table
          rowKey="名"
          size="small"
          pagination={false}
          dataSource={报告.文件}
          title={() => <b>读进来的文件</b>}
          columns={[
            { title: "文件", dataIndex: "名" },
            { title: "行数", dataIndex: "行数", width: 90 },
            {
              title: "是哪一类",
              width: 200,
              render: (_, f) => (
                <Select<实体>
                  size="small"
                  style={{ width: 170 }}
                  disabled={只读}
                  status={!f.实体 && !改.文件实体?.[f.名] ? "warning" : undefined}
                  placeholder="认不出，请选"
                  value={改.文件实体?.[f.名] ?? f.实体 ?? undefined}
                  options={实体顺序.map((e) => ({ value: e, label: 实体名[e] }))}
                  onChange={(v) => set改((x) => ({ ...x, 文件实体: { ...x.文件实体, [f.名]: v } }))}
                />
              ),
            },
            { title: "读的时候发现的", render: (_, f) => f.提醒.join("；") || "—" },
          ]}
        />
      )}

      <Table
        rowKey="实体"
        size="small"
        pagination={false}
        title={() => (
          <b>
            一共 {报告.合计.记录} 条：会写 {报告.合计.待写} 条，跳过 {报告.合计.跳过} 条，要看一眼的 {报告.合计.提醒} 条
          </b>
        )}
        dataSource={实体顺序.map((e) => ({ 实体: e, ...报告.按类[e] })).filter((x) => x.待写 + x.跳过 + x.提醒 > 0)}
        columns={[
          { title: "类别", render: (_, x) => 实体名[x.实体] },
          { title: "新建", dataIndex: "新建" },
          { title: "更新", dataIndex: "更新" },
          { title: "没变", dataIndex: "没变" },
          { title: "并入已有", dataIndex: "并入" },
          { title: "跳过", dataIndex: "跳过" },
          { title: "要看一眼", dataIndex: "提醒" },
        ]}
      />

      {报告.预演 && (
        <Table
          rowKey="实体"
          size="small"
          pagination={false}
          title={() => (
            <b>
              先照正式导入演了一遍（没写进库）：写完会新建 {报告.预演!.合计.新建} 条、更新 {报告.预演!.合计.更新} 条、跳过 {报告.预演!.合计.跳过} 条、冲突 {报告.预演!.合计.冲突} 条、写不进 {报告.预演!.合计.失败} 条
            </b>
          )}
          dataSource={实体顺序.flatMap((e) => (报告.预演!.按类[e] ? [{ 实体: e, ...报告.预演!.按类[e]! }] : []))}
          columns={[
            { title: "类别", render: (_, x) => 实体名[x.实体] },
            { title: "新建", dataIndex: "新建" },
            { title: "更新", dataIndex: "更新" },
            { title: "跳过", dataIndex: "跳过" },
            { title: "冲突", dataIndex: "冲突" },
            { title: "写不进", dataIndex: "失败" },
          ]}
        />
      )}

      {报告.公海 && 报告.公海.会掉 > 0 && (
        <Alert type="info" showIcon title={`导入后会有 ${报告.公海.会掉} 个客户放进公海`} description={`业务设置里开了「${报告.公海.天数} 天没跟进放进公海」，按原系统的跟进时间算，这些客户已经超过期限。不想这样，导入前先去业务配置里调天数。`} />
      )}

      {报告.问题总数 > 0 && (
        <div>
          <Space wrap size={[6, 6]} style={{ marginBottom: 8 }}>
            {报告.问题分类.map((c) => (
              <Tag key={`${c.实体}-${c.级别}-${c.类别}`} color={c.级别 === "跳过" ? "red" : "gold"}>
                {实体名[c.实体]} · {c.类别} · {c.级别} {c.数}
              </Tag>
            ))}
          </Space>
          <Table<问题>
            rowKey={(p) => `${p.实体}-${p.外部ID}-${p.类别}-${p.行号 ?? ""}`}
            size="small"
            dataSource={报告.问题}
            pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
            title={() =>
              报告.问题总数 > 报告.问题.length ? (
                <Typography.Text type="secondary">问题一共 {报告.问题总数} 条，这里列前 {报告.问题.length} 条；改好映射重新试跑会少很多</Typography.Text>
              ) : null
            }
            columns={[
              { title: "", width: 64, render: (_, p) => <Tag color={p.级别 === "跳过" ? "red" : "gold"}>{p.级别}</Tag> },
              { title: "类别", width: 110, dataIndex: "类别" },
              { title: "哪一条", width: 220, render: (_, p) => `${实体名[p.实体]} · ${p.出处 ? `${p.出处}${p.行号 ? ` 第 ${p.行号} 行` : ""}` : p.外部ID}` },
              { title: "说明", dataIndex: "说明" },
            ]}
          />
        </div>
      )}

      <Collapse
        items={[
          {
            key: "列",
            label: "列对到哪个字段",
            children: (
              <Space orientation="vertical" size={12} style={{ display: "flex" }}>
                {实体顺序.filter((e) => 报告.映射.列[e]?.length).map((e) => 列表格(e, 报告.映射.列[e]!))}
              </Space>
            ),
          },
          ...(报告.映射.值.length
            ? [
                {
                  key: "值",
                  label: `阶段、状态这些值怎么换（${报告.映射.值.length}）`,
                  children: (
                    <Table
                      rowKey={(v) => `${v.名}-${v.原值}`}
                      size="small"
                      pagination={false}
                      dataSource={报告.映射.值}
                      columns={[
                        { title: "", width: 100, dataIndex: "叫法" },
                        { title: "原系统的值", dataIndex: "原值" },
                        {
                          title: "换成我们的",
                          width: 220,
                          render: (_, v) => (
                            <Select
                              size="small"
                              style={{ width: 200 }}
                              disabled={只读}
                              value={改.值?.[v.名]?.[v.原值] ?? v.我们的值}
                              options={(概况.合法值们[v.名] ?? []).map((x) => ({ value: x.值, label: x.说法 }))}
                              onChange={(x) => 改值(v.名, v.原值, x)}
                            />
                          ),
                        },
                        { title: "谁认的", width: 80, render: (_, v) => (改.值?.[v.名]?.[v.原值] !== undefined ? <Tag color="blue">手动</Tag> : v.说明 ? <Tag color={说明色[v.说明]}>{v.说明}</Tag> : null) },
                      ]}
                    />
                  ),
                },
              ]
            : []),
          {
            key: "人",
            label: `负责人对谁（${报告.映射.负责人.length}）`,
            children: (
              <Space orientation="vertical" size={10} style={{ display: "flex" }}>
                <Space size={8}>
                  对不上的落到
                  <Select
                    size="small"
                    style={{ width: 180 }}
                    disabled={只读}
                    value={改.默认负责人Id ?? 报告.映射.默认负责人.id}
                    options={成员选项}
                    onChange={(v) => set改((x) => ({ ...x, 默认负责人Id: v }))}
                  />
                  名下
                </Space>
                {报告.映射.负责人.length > 0 && (
                  <Table
                    rowKey="写法"
                    size="small"
                    pagination={false}
                    dataSource={报告.映射.负责人}
                    columns={[
                      { title: "原系统里写的", dataIndex: "写法" },
                      {
                        title: "我们的成员",
                        width: 220,
                        render: (_, p) => (
                          <Select
                            size="small"
                            style={{ width: 200 }}
                            disabled={只读}
                            value={改.负责人?.[p.写法] ?? p.成员Id}
                            options={[{ value: "", label: "用默认负责人" }, ...成员选项]}
                            onChange={(v) => 改人(p.写法, v)}
                          />
                        ),
                      },
                      { title: "谁认的", width: 80, render: (_, p) => (改.负责人?.[p.写法] !== undefined ? <Tag color="blue">手动</Tag> : p.说明 ? <Tag color={说明色[p.说明]}>{p.说明}</Tag> : null) },
                    ]}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />

      {进度 && <Progress percent={Math.floor((进度.写到 / Math.max(1, 进度.总数)) * 100)} status="active" format={() => `${进度.写到} / ${进度.总数}`} />}

      {!只读 && (
        <Space wrap size={8}>
          <Button disabled={!改了几处 || !!忙} loading={忙 === "重跑"} onClick={() => void 重跑()}>
            按改的重新试跑{改了几处 ? `（改了 ${改了几处} 处）` : ""}
          </Button>
          <Popconfirm
            title="确认正式导入？"
            description={
              改了几处
                ? "你改的映射还没重新试跑，先点「按改的重新试跑」再导入"
                : 报告.预演
                  ? `会新建 ${报告.预演.合计.新建} 条、更新 ${报告.预演.合计.更新} 条，跳过 ${报告.预演.合计.跳过} 条，${报告.预演.合计.冲突} 条冲突${报告.预演.合计.失败 ? `，${报告.预演.合计.失败} 条写不进` : ""}。我们这边改过的不覆盖，只记一笔冲突。导完可以整批撤回。`
                  : `会写 ${报告.合计.待写} 条（跳过 ${报告.合计.跳过} 条）。我们这边改过的不覆盖，只记一笔冲突。导完可以整批撤回。`
            }
            okText="导入"
            okButtonProps={{ disabled: 改了几处 > 0 }}
            onConfirm={() => void 导入()}
          >
            <Button type="primary" disabled={!!忙 || 报告.合计.待写 === 0 || 要选类别.length === 报告.文件.length && 报告.文件.length > 0} loading={忙 === "导入"}>
              确认，正式导入
            </Button>
          </Popconfirm>
          <Popconfirm title="不要这次试跑了？" description="只删这份报告，什么都还没写进去。" okText="不要了" onConfirm={() => void 丢掉()}>
            <Button type="text" danger disabled={!!忙} loading={忙 === "丢掉"}>
              不要这次试跑
            </Button>
          </Popconfirm>
        </Space>
      )}
    </Space>
  );
}
