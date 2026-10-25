"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Alert, Button, Card, Empty, Popconfirm, Select, Space, Spin, Switch, Table, Tabs, Tag, Typography, Upload, type UploadFile } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { smartTime } from "@/lib/utils";
import { 来源名, 字段中文 } from "@/lib/enterprise-import/types";
import { 单个请求最长毫秒 } from "@/lib/enterprise-import/net";
import type { 试跑报告 } from "@/lib/enterprise-import/report";
import {
  企业版导入概况,
  取试跑报告,
  丢掉试跑,
  正式导入一段,
  撤回一段,
  恢复一段,
  冲突列表,
  定这些冲突,
  改同步,
  立即同步,
  从接口拉全量,
  切换这个来源,
  下载快照,
  type 企业版概况,
  type 批次行,
  type 撤回一段结果,
} from "./enterprise-import-actions";
import EnterpriseImportReport from "./EnterpriseImportReport";

/**
 * 设置 → 企业版导入（只有 CRM_ENTERPRISE=1、管理员、不在共享试用区时才摆出来）。
 *
 * 四块：导入（传 Excel / CSV 出试跑报告）、批次（每批能接着写、整批撤回、恢复）、
 * 冲突（我们这边改过、原系统也改了的，人来定）、同步与切换（飞书 / 钉钉定时拉，切换日关掉留快照）。
 * 和「导入记录」那一栏（ImportsTab，客户业务管）是两套：那边是普通的单文件导入，这边按来源 + 原系统 ID 对照。
 */

const 状态说法: Record<string, { 话: string; 色: string }> = {
  preview: { 话: "试跑完，等确认", 色: "gold" },
  applying: { 话: "写入中", 色: "processing" },
  done: { 话: "已导入", 色: "green" },
  reverting: { 话: "撤回中", 色: "processing" },
  reverted: { 话: "已撤回", 色: "default" },
  restoring: { 话: "恢复中", 色: "processing" },
};

const 结果色: Record<string, string> = { 成功: "green", 没变化: "default", 没接: "gold", 出错: "red", 跳过: "default" };

const 错话 = (e: unknown) => (e instanceof Error ? e.message : "没成功，请重试");

type 冲突页 = Awaited<ReturnType<typeof 冲突列表>>;

export default function EnterpriseImportTab() {
  const { message, modal } = App.useApp();
  const [概况, set概况] = useState<企业版概况 | null>(null);
  const [出错, set出错] = useState<string | null>(null);
  const [页签, set页签] = useState("import");
  /** 正在看的试跑报告（刚上传的、批次列表里点开的、接口拉全量出来的） */
  const [看, set看] = useState<{ 批次Id: string; 报告: 试跑报告; 只读: boolean } | null>(null);
  /** 正在一段一段跑的批次（导入 / 撤回 / 恢复），同一时间只跑一个 */
  const [跑, set跑] = useState<{ id: string; 话: string } | null>(null);

  const 载入 = useCallback(
    () =>
      企业版导入概况()
        .then((r) => {
          set概况(r);
          set出错(null);
        })
        .catch((e: unknown) => set出错(错话(e))),
    [],
  );

  useEffect(() => {
    void 载入();
  }, [载入]);

  // 有来源正在同步（定时那次、别人点的）：每 5 秒看一眼，拉完自动刷新「上次」
  const 有在同步 = !!概况?.同步.some((s) => s.在同步);
  useEffect(() => {
    if (!有在同步) return;
    const t = setInterval(() => void 载入(), 5000);
    return () => clearInterval(t);
  }, [有在同步, 载入]);

  if (出错 && !概况) {
    return <Alert type="error" showIcon title="企业版导入没打开" description={出错} action={<Button size="small" onClick={() => void 载入()}>重试</Button>} />;
  }
  if (!概况) return <Spin style={{ display: "block", margin: "48px auto" }} />;

  const 打开报告 = (批次Id: string, 报告: 试跑报告, 只读 = false) => {
    set看({ 批次Id, 报告, 只读 });
    set页签("import");
  };

  /** 一段一段调到完了：写入 / 撤回 / 恢复共用 */
  async function 一直跑<T extends { 完了: boolean; 状态: string }>(b: 批次行, 话: string, 进行中: string, 一段: (id: string) => Promise<T>): Promise<T | null> {
    set跑({ id: b.id, 话 });
    try {
      for (;;) {
        const r = await 一段(b.id);
        if (r.完了) return r;
        if (r.状态 !== 进行中) {
          message.info("这一批别处正在处理，稍后刷新看结果");
          return null;
        }
      }
    } catch (e) {
      message.error(`${错话(e)}。已经做了的留着，可以再点「接着」`);
      return null;
    } finally {
      set跑(null);
      void 载入();
    }
  }

  const 撤回的话 = (r: 撤回一段结果, 动作: "撤回" | "恢复") =>
    动作 === "撤回"
      ? `删掉新建的 ${r.删掉} 条，更新过的还原 ${r.还原} 条${r.留下数 ? `；${r.留下数} 条后来又被改过，没动：${r.留下.slice(0, 5).join("；")}${r.留下数 > 5 ? "……" : ""}` : ""}`
      : `恢复 ${r.恢复} 条${r.留下数 ? `；${r.留下数} 条没恢复：${r.留下.slice(0, 5).join("；")}${r.留下数 > 5 ? "……" : ""}` : ""}`;

  async function 写(b: 批次行) {
    const r = await 一直跑(b, "导入中", "applying", 正式导入一段);
    if (r) message.success(`导入完成：新建 ${r.新建}，更新 ${r.更新}，跳过 ${r.跳过}${r.冲突 ? `，冲突 ${r.冲突}` : ""}${r.失败 ? `，失败 ${r.失败}` : ""}`);
  }
  async function 撤(b: 批次行) {
    const r = await 一直跑(b, "撤回中", "reverting", 撤回一段);
    if (r) modal.success({ title: "整批撤回完成", content: 撤回的话(r, "撤回") });
  }
  async function 恢复(b: 批次行) {
    const r = await 一直跑(b, "恢复中", "restoring", 恢复一段);
    if (r) modal.success({ title: "恢复完成", content: 撤回的话(r, "恢复") });
  }

  async function 看报告(b: 批次行) {
    try {
      const r = await 取试跑报告(b.id);
      if (!r) return message.warning("这一批没有存报告");
      打开报告(b.id, r.报告, r.状态 !== "preview");
    } catch (e) {
      message.error(错话(e));
    }
  }

  async function 丢(b: 批次行) {
    try {
      await 丢掉试跑(b.id);
      if (看?.批次Id === b.id) set看(null);
      void 载入();
    } catch (e) {
      message.error(错话(e));
    }
  }

  const 批次表 = (
    <Table<批次行>
      rowKey="id"
      size="middle"
      dataSource={概况.批次们}
      pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
      locale={{ emptyText: "还没有导入过" }}
      expandable={{
        rowExpandable: (b) => b.失败明细.length > 0 || !!b.撤回账,
        expandedRowRender: (b) => (
          <Space orientation="vertical" size={6} style={{ display: "flex" }}>
            {b.撤回账 && (
              <Typography.Text>
                最近一次{b.撤回账.动作}：
                {b.撤回账.动作 === "恢复"
                  ? `恢复 ${b.撤回账.恢复} 条`
                  : `删掉 ${b.撤回账.删掉} 条，还原 ${b.撤回账.还原} 条`}
                {b.撤回账.留下数 ? `，${b.撤回账.留下数} 条没动` : ""}
              </Typography.Text>
            )}
            {b.撤回账?.留下.map((s, i) => (
              <Typography.Text key={`l${i}`} type="secondary">
                · {s}
              </Typography.Text>
            ))}
            {b.失败明细.length > 0 && <Typography.Text type="danger">没写进去的：</Typography.Text>}
            {b.失败明细.map((s, i) => (
              <Typography.Text key={`f${i}`} type="secondary">
                · {s}
              </Typography.Text>
            ))}
          </Space>
        ),
      }}
      columns={[
        { title: "时间", width: 120, render: (_, b) => smartTime(b.时间) },
        { title: "来源", width: 150, render: (_, b) => `${来源名[b.来源] ?? b.来源} · ${b.类型 === "sync" ? "同步" : "首次导入"}` },
        {
          title: "状态",
          width: 130,
          render: (_, b) => {
            const s = 跑?.id === b.id ? { 话: 跑.话, 色: "processing" } : 状态说法[b.状态] ?? { 话: b.状态, 色: "default" };
            return <Tag color={s.色}>{s.话}</Tag>;
          },
        },
        {
          title: "数量",
          render: (_, b) =>
            b.状态 === "preview"
              ? `待写 ${b.总数}`
              : `${b.状态 === "applying" ? `${b.写到}/${b.总数}，` : ""}新建 ${b.新建}，更新 ${b.更新}，跳过 ${b.跳过}${b.冲突 ? `，冲突 ${b.冲突}` : ""}${b.失败 ? `，失败 ${b.失败}` : ""}`,
        },
        { title: "谁", width: 90, dataIndex: "人名" },
        {
          title: "",
          width: 190,
          render: (_, b) => {
            const 忙 = !!跑;
            switch (b.状态) {
              case "preview":
                return (
                  <Space size={8}>
                    <Button size="small" onClick={() => void 看报告(b)}>看报告</Button>
                    <Popconfirm title="不要这次试跑了？" okText="不要了" onConfirm={() => void 丢(b)}>
                      <Button size="small" type="text" danger>丢掉</Button>
                    </Popconfirm>
                  </Space>
                );
              case "applying":
                return <Button size="small" disabled={忙} loading={跑?.id === b.id} onClick={() => void 写(b)}>接着导入</Button>;
              case "done":
                return (
                  <Space size={8}>
                    {b.类型 === "full" && <Button size="small" type="text" onClick={() => void 看报告(b)}>报告</Button>}
                    <Popconfirm
                      title="整批撤回？"
                      description="这批新建的删掉（进回收站），更新过的还原成导入前。导入之后又被人改过的不动，撤完会列出来。之后还能恢复。"
                      okText="撤回"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void 撤(b)}
                    >
                      <Button size="small" danger disabled={忙}>撤回</Button>
                    </Popconfirm>
                  </Space>
                );
              case "reverting":
                return <Button size="small" disabled={忙} loading={跑?.id === b.id} onClick={() => void 撤(b)}>接着撤回</Button>;
              case "reverted":
                return (
                  <Popconfirm title="把撤回的恢复回来？" okText="恢复" onConfirm={() => void 恢复(b)}>
                    <Button size="small" disabled={忙}>恢复</Button>
                  </Popconfirm>
                );
              case "restoring":
                return <Button size="small" disabled={忙} loading={跑?.id === b.id} onClick={() => void 恢复(b)}>接着恢复</Button>;
              default:
                return null;
            }
          },
        },
      ]}
    />
  );

  return (
    <Tabs
      activeKey={页签}
      onChange={set页签}
      items={[
        {
          key: "import",
          label: "导入",
          children: 看 ? (
            <Space orientation="vertical" size={12} style={{ display: "flex" }}>
              <Button type="link" style={{ padding: 0 }} onClick={() => set看(null)}>
                ← 返回
              </Button>
              <EnterpriseImportReport
                key={看.批次Id}
                批次Id={看.批次Id}
                报告={看.报告}
                只读={看.只读}
                概况={概况}
                on改了={(r) => set看((x) => (x ? { ...x, 报告: r } : x))}
                on完了={() => {
                  set看(null);
                  set页签("batches");
                  void 载入();
                }}
              />
            </Space>
          ) : (
            <UploadPane on出报告={(id, r) => { 打开报告(id, r); void 载入(); }} />
          ),
        },
        { key: "batches", label: "批次", children: 批次表 },
        {
          key: "conflicts",
          label: 概况.待定冲突 ? `冲突（${概况.待定冲突}）` : "冲突",
          children: <ConflictPane on变了={() => void 载入()} />,
        },
        {
          key: "sync",
          label: "同步与切换",
          children: <SyncPane 概况={概况} on变了={() => void 载入()} on出报告={(id, r) => { 打开报告(id, r); void 载入(); }} />,
        },
      ]}
    />
  );
}

/* ───────────────────────── 导入：传文件 ───────────────────────── */

function UploadPane({ on出报告 }: { on出报告: (批次Id: string, 报告: 试跑报告) => void }) {
  const { message } = App.useApp();
  const [文件们, set文件们] = useState<UploadFile[]>([]);
  const [传, set传] = useState(false);

  async function 试跑() {
    set传(true);
    try {
      const fd = new FormData();
      for (const f of 文件们) if (f.originFileObj) fd.append("files", f.originFileObj, f.name);
      const res = await fetch("/api/enterprise-import/upload", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { 批次Id?: string; 报告?: 试跑报告; error?: string };
      if (!res.ok || !j.批次Id || !j.报告) throw new Error(j.error ?? `上传没成功（${res.status}）`);
      set文件们([]);
      on出报告(j.批次Id, j.报告);
    } catch (e) {
      message.error(错话(e));
    } finally {
      set传(false);
    }
  }

  return (
    <Space orientation="vertical" size={14} style={{ display: "flex" }}>
      <Alert
        type="info"
        showIcon
        title="从飞书 / 钉钉导出 Excel 传上来，先试跑出报告，看过再正式导入"
        description="客户、联系人、商机、跟进记录可以分几个文件一起传，也可以放在一个 Excel 的几个工作表里。AI 认列和清洗（重名、负责人对不上、阶段名不同），用的是你们自己在「AI 设置」里填的 Key；没填就只按规则认。每条记下原系统 ID，以后再导同一批只更新变了的。"
      />
      <Upload.Dragger
        multiple
        accept=".xlsx,.csv"
        fileList={文件们}
        beforeUpload={() => false}
        onChange={({ fileList }) => set文件们(fileList.slice(-10))}
        disabled={传}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点这里或把文件拖进来</p>
        <p className="ant-upload-hint">.xlsx / .csv，最多 10 个文件，合计 200 MB 以内</p>
      </Upload.Dragger>
      <Button type="primary" disabled={!文件们.length} loading={传} onClick={() => void 试跑()}>
        {传 ? "读文件、认列、清洗中…" : "试跑"}
      </Button>
    </Space>
  );
}

/* ───────────────────────── 冲突 ───────────────────────── */

const 每页冲突 = 50;

function ConflictPane({ on变了 }: { on变了: () => void }) {
  const { message, modal } = App.useApp();
  const [页, set页] = useState(1);
  const [数据, set数据] = useState<冲突页 | null>(null);
  const [载, set载] = useState(false);
  const [选, set选] = useState<string[]>([]);
  const [定, set定] = useState<"采用原系统" | "保留我们" | null>(null);

  // 转圈在调用前由点的地方开（effect 里不直接 setState）
  const 拉 = useCallback(
    (p: number) =>
      冲突列表({ 跳过: (p - 1) * 每页冲突, 取: 每页冲突 })
        .then(set数据)
        .catch((e: unknown) => message.error(错话(e)))
        .finally(() => set载(false)),
    [message],
  );

  useEffect(() => {
    void 拉(页);
  }, [拉, 页]);

  async function 定这些(选法: "采用原系统" | "保留我们") {
    set定(选法);
    try {
      const r = await 定这些冲突(选, 选法);
      set选([]);
      const 话 = `定了 ${r.定了} 笔${r.过时 ? `，${r.过时} 笔记下之后两边又变了，标成已过时` : ""}`;
      if (r.没定.length) {
        modal.warning({
          title: 话,
          content: (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {r.没定.slice(0, 20).map((x) => (
                <li key={x.冲突Id}>
                  {x.名称 ?? x.外部ID ?? x.冲突Id}：{x.原因}
                </li>
              ))}
            </ul>
          ),
        });
      } else message.success(话);
      set载(true);
      void 拉(页);
      on变了();
    } catch (e) {
      message.error(错话(e));
    } finally {
      set定(null);
    }
  }

  if (!数据) return <Spin style={{ display: "block", margin: "32px auto" }} />;

  return (
    <Space orientation="vertical" size={12} style={{ display: "flex" }}>
      <Alert
        type="info"
        showIcon
        title="我们这边改过的，同步不会覆盖"
        description="原系统那边也改了同一条的，记在这里。选「采用原系统」会换成原系统的值（能整批撤回），选「保留我们」就不再提这几处。"
      />
      <Space wrap size={8}>
        <Button disabled={!选.length || !!定} loading={定 === "采用原系统"} onClick={() => void 定这些("采用原系统")}>
          采用原系统{选.length ? `（${选.length}）` : ""}
        </Button>
        <Button disabled={!选.length || !!定} loading={定 === "保留我们"} onClick={() => void 定这些("保留我们")}>
          保留我们{选.length ? `（${选.length}）` : ""}
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="middle"
        loading={载}
        dataSource={数据.条目}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待定的冲突" /> }}
        rowSelection={{
          selectedRowKeys: 选,
          onChange: (k) => set选((k as string[]).slice(0, 200)),
        }}
        pagination={{ current: 页, pageSize: 每页冲突, total: 数据.总数, showSizeChanger: false, hideOnSinglePage: true, onChange: (p) => { set载(true); set页(p); set选([]); } }}
        columns={[
          {
            title: "哪一条",
            width: 220,
            render: (_, c) => (
              <Space orientation="vertical" size={2}>
                <span>
                  {c.实体名} · {c.名称 || c.外部ID}
                </span>
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {来源名[c.来源] ?? c.来源} · {smartTime(c.记下时间)}
                  </Typography.Text>
                  {c.本地已删 && <Tag color="red">我们这边已删</Tag>}
                </Space>
              </Space>
            ),
          },
          {
            title: "不一样的地方（我们 → 原系统）",
            render: (_, c) => (
              <Space orientation="vertical" size={2}>
                {Object.entries(c.字段).map(([f, v]) => (
                  <span key={f}>
                    <b>{字段中文[f] ?? f}</b>：<Typography.Text>{显示(v.我们)}</Typography.Text>
                    {" → "}
                    <Typography.Text type="warning">{显示(v.原系统)}</Typography.Text>
                  </span>
                ))}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

const 显示 = (v: unknown) => (v === null || v === undefined || v === "" ? "（空）" : String(v));

/* ───────────────────────── 同步与切换 ───────────────────────── */

function SyncPane({ 概况, on变了, on出报告 }: { 概况: 企业版概况; on变了: () => void; on出报告: (批次Id: string, 报告: 试跑报告) => void }) {
  const { message, modal } = App.useApp();
  const [忙, set忙] = useState<string | null>(null);

  async function 做<T>(键: string, f: () => Promise<T>): Promise<T | null> {
    set忙(键);
    try {
      return await f();
    } catch (e) {
      message.error(错话(e));
      return null;
    } finally {
      set忙(null);
      on变了();
    }
  }

  async function 下载(id: string) {
    const r = await 做(`dl-${id}`, () => 下载快照(id));
    if (!r) return;
    const url = URL.createObjectURL(new Blob([r.内容], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.文件名;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Space orientation="vertical" size={14} style={{ display: "flex" }}>
      {概况.同步.map(({ 来源: 源, 名, 能同步, 设置, 在同步 }) => {
        // 这边刚点的还没进概况，也算在同步
        const 拉着 = 在同步 ?? (忙 === `同步-${源}` ? { 开始: null, 谁: "你" } : null);
        return (
          <Card
            key={源}
            size="small"
            title={名}
            extra={
              拉着 ? <Tag color="processing">正在同步</Tag>
              : 设置.切换 ? <Tag>已在 {设置.切换.时间.slice(0, 10)} 切换</Tag>
              : 设置.开 ? <Tag color="green">自动同步开着</Tag>
              : null
            }
          >
            <Space orientation="vertical" size={10} style={{ display: "flex" }}>
              {能同步 && !设置.切换 && (
                <>
                  {拉着 && (
                    <Alert
                      type="info"
                      showIcon
                      title={`正在从${名}同步（${拉着.谁}${拉着.开始 ? ` ${smartTime(拉着.开始)}` : "刚才"}点的）`}
                      description={`对方慢或断网时，每个请求最长等约 ${Math.round(单个请求最长毫秒 / 1000)} 秒，整次可能要几分钟；拉完这里会自动刷新，不用重复点。`}
                    />
                  )}
                  <Space wrap size={8}>
                    <Switch
                      checked={设置.开}
                      loading={忙 === `开-${源}`}
                      onChange={(v) => void 做(`开-${源}`, () => 改同步(源, { 开: v }))}
                    />
                    自动同步
                    <Select
                      size="small"
                      style={{ width: 100 }}
                      value={设置.频率}
                      options={[{ value: "每小时", label: "每小时" }, { value: "每晚", label: "每晚" }]}
                      onChange={(v) => void 做(`频-${源}`, () => 改同步(源, { 频率: v }))}
                    />
                    {设置.频率 === "每晚" && (
                      <Select
                        size="small"
                        style={{ width: 150 }}
                        value={设置.几点}
                        options={Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${h}:00（服务器时间）` }))}
                        onChange={(v) => void 做(`点-${源}`, () => 改同步(源, { 几点: v }))}
                      />
                    )}
                  </Space>
                  <Space wrap size={8}>
                    <Button
                      size="small"
                      loading={!!拉着}
                      disabled={!!忙 || !!拉着}
                      onClick={async () => {
                        const r = await 做(`同步-${源}`, () => 立即同步(源));
                        if (r) message[r.结果 === "出错" ? "error" : r.结果 === "成功" ? "success" : "info"](r.话);
                      }}
                    >
                      立即同步
                    </Button>
                    <Button
                      size="small"
                      loading={忙 === `全量-${源}`}
                      disabled={!!忙 || !!拉着}
                      onClick={async () => {
                        const r = await 做(`全量-${源}`, () => 从接口拉全量(源));
                        if (r) on出报告(r.批次Id, r.报告);
                      }}
                    >
                      从{名}拉全量试跑
                    </Button>
                  </Space>
                  {设置.上次 && (
                    <Typography.Text type="secondary">
                      上次 {smartTime(设置.上次.时间)}：<Tag color={结果色[设置.上次.结果]}>{设置.上次.结果}</Tag>
                      {设置.上次.话}
                    </Typography.Text>
                  )}
                </>
              )}
              {!能同步 && <Typography.Text type="secondary">Excel 没有自动同步：把新导出的文件再传一次，按原系统 ID 只更新变了的。</Typography.Text>}
              {!设置.切换 && (
                <div>
                  <Popconfirm
                    title={`确认切换${名}？`}
                    description={
                      <div style={{ maxWidth: 320 }}>
                        切换后{名}的同步永久关掉、不能再开；那一刻所有对照（原系统 ID ↔ 我们的记录）留一份快照可下载。已导的批次还能撤回，待定的冲突还能定。
                      </div>
                    }
                    okText="切换"
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      const r = await 做(`切换-${源}`, () => 切换这个来源(源));
                      if (r)
                        modal.success({
                          title: `${名}已切换`,
                          content: `快照留了 ${r.条数} 条对照${r.待定冲突 ? `；还有 ${r.待定冲突} 笔冲突待定，到「冲突」里处理` : ""}。`,
                        });
                    }}
                  >
                    <Button size="small" danger disabled={!!忙} loading={忙 === `切换-${源}`}>
                      切换（不再从{名}同步）
                    </Button>
                  </Popconfirm>
                </div>
              )}
            </Space>
          </Card>
        );
      })}

      <Card size="small" title="切换快照">
        {概况.快照们.length ? (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={概况.快照们}
            columns={[
              { title: "来源", dataIndex: "名" },
              { title: "时间", render: (_, s) => smartTime(s.时间) },
              { title: "对照条数", dataIndex: "条数" },
              { title: "谁切的", dataIndex: "人名" },
              {
                title: "",
                width: 90,
                render: (_, s) => (
                  <Button size="small" type="link" loading={忙 === `dl-${s.id}`} onClick={() => void 下载(s.id)}>
                    下载
                  </Button>
                ),
              },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">还没有切换过</Typography.Text>
        )}
      </Card>
    </Space>
  );
}

