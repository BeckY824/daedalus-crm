"use client";

import { useMemo, useState } from "react";
import { App, Alert, Button, Drawer, Empty, Radio, Select, Space, Steps, Switch, Table, Tag, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { 解析CSV, 成表, 行数上限, 列数上限 } from "@/lib/import/parse";
import { 字段表, 猜列, 像表头, type 字段名 } from "@/lib/import/fields";
import { 改动键 } from "@/lib/import/plan";
import { 预览导入, 执行导入, 撤销批次, type 预览, type 导入方案 } from "./import-actions";
import type { BusinessConfig } from "@/lib/business-config";

/**
 * 把手上那份表导进来。五步一屏，走完能整批撤销。
 *
 * ## 为什么是一个抽屉而不是一个页面
 *
 * 导入是一件做完就走的事，不是一个要收进导航的模块。
 * 全站那条布局规则（全局导航稳定，局部结构服从任务）在这儿的落法就是：
 * 不加第九个左栏条目，从客户列表页头上那颗按钮进。
 *
 * ## xlsx 在这一层变成和 csv 一样的东西
 *
 * 浏览器里解析完立刻转成同一个二维数组（`成表` 的入参），**从这里往后只有一套逻辑**。
 * 两条管线的下场是复核、预览、撤销各写两遍，其中一遍迟早落后。
 * 解析器在 lib/import/xlsx.ts，按需加载——它带着 fflate，
 * 只导 csv 的人不该为此多下一份 js。
 *
 * ## 这一版明确不做的
 *
 * 自定义字段、当场新建渠道、导入跟进记录、多工作表、后台任务。
 * 一万行在 SQLite 上是几秒钟的事，排队反而多一处要解释的状态。
 */
export default function ImportDrawer({
  open,
  onClose,
  b,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  b: BusinessConfig;
  onDone: () => void;
}) {
  const { message, modal } = App.useApp();
  const 表 = useMemo(() => 字段表(b), [b]);

  const [步, set步] = useState(0);
  const [文件名, set文件名] = useState("");
  const [表头, set表头] = useState<string[]>([]);
  const [数据, set数据] = useState<string[][]>([]);
  const [截断了, set截断了] = useState<{ 行?: number; 列?: number } | undefined>();
  const [映射, set映射] = useState<(字段名 | null)[]>([]);
  const [改过, set改过] = useState<Record<string, string>>({});
  const [重复行, set重复行] = useState<导入方案["重复行"]>("跳过");
  const [没对上的列, set没对上的列] = useState<导入方案["没对上的列"]>("并进备注");
  const [看, set看] = useState<预览 | null>(null);
  const [忙, set忙] = useState(false);
  const [结果, set结果] = useState<{ batchId: string; 新建: number; 补空: number; 跳过: number; 进不了: number } | null>(null);

  const 方案 = (): 导入方案 => ({ 表头, 数据, 映射, 改过, 重复行, 没对上的列 });

  function 重来() {
    set步(0);
    set文件名("");
    set表头([]);
    set数据([]);
    set截断了(undefined);
    set映射([]);
    set改过({});
    set重复行("跳过");
    set没对上的列("并进备注");
    set看(null);
    set结果(null);
  }

  async function 收文件(f: File) {
    set忙(true);
    try {
      let rows: string[][];
      if (/\.xlsx$/i.test(f.name)) {
        // 按需加载：只导 csv 的人不该为此多下一份解析器
        const { 读xlsx } = await import("@/lib/import/xlsx");
        rows = 读xlsx(new Uint8Array(await f.arrayBuffer()));
      } else if (/\.xls$/i.test(f.name)) {
        message.error("这是 2003 年那种老格式，请在 Excel 里另存为 .xlsx 或 .csv 再来");
        return;
      } else {
        rows = 解析CSV(await f.text());
      }
      const t = 成表(rows);
      if (t.表头.length === 0 || t.数据.length === 0) {
        message.error("这份表里没有数据。第一行要是表头，第二行起是内容");
        return;
      }
      set文件名(f.name);
      set表头(t.表头);
      set数据(t.数据);
      set截断了(t.截断了);
      set映射(猜列(t.表头, 表));
      set改过({});
      set步(1);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "这个文件读不出来");
    } finally {
      set忙(false);
    }
  }

  const 认人列 = 映射.indexOf("phone");

  async function 去预览() {
    set忙(true);
    try {
      const r = await 预览导入(方案());
      if (!r.ok) return message.error(r.error);
      set看(r.预览);
      set步(2);
    } catch (e) {
      // server action 抛出来的那一种失败也要说话。不接住的话 finally 把忙置回 false，
      // 界面一声不吭，人只会以为这颗按钮坏了
      message.error(e instanceof Error ? e.message : "算不出来，请重试");
    } finally {
      set忙(false);
    }
  }

  async function 落库() {
    set忙(true);
    try {
      const r = await 执行导入(方案(), 文件名);
      if (!r.ok) return message.error(r.error);
      set结果(r);
      set步(4);
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "导入没能完成，请重试");
    } finally {
      set忙(false);
    }
  }

  async function 撤() {
    if (!结果) return;
    set忙(true);
    try {
      const r = await 撤销批次(结果.batchId);
      if (!r.ok) return message.error(r.error);
      onDone();
      const 尾 = r.没动.length
        ? `。有 ${r.没动.length} 位没动：${r.没动.slice(0, 3).map((x) => `${x.name}（${x.原因}）`).join("、")}${r.没动.length > 3 ? " 等" : ""}`
        : "";
      modal.success({ title: "已撤销这一批", content: `删掉 ${r.删掉} 条，还原 ${r.还原} 条${尾}` });
      重来();
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "撤销没能完成，请重试");
    } finally {
      set忙(false);
    }
  }

  return (
    <Drawer
      title={`导入${b.customer}`}
      open={open}
      styles={{ wrapper: { width: 880 } }}
      onClose={() => {
        onClose();
        // 关掉再打开是重新导一份，不是接着上一份走
        setTimeout(重来, 200);
      }}
      footer={<页脚 {...{ 步, 忙, 认人列, 看, set步, 去预览, 落库, 撤, 重来, onClose }} />}
    >
      <Steps
        size="small"
        current={步}
        style={{ marginBottom: 20 }}
        items={[{ title: "选文件" }, { title: "对列" }, { title: "复核" }, { title: "执行" }, { title: "完成" }]}
      />

      {步 === 0 && (
        <>
          <Upload.Dragger
            accept=".csv,.xlsx,.xls,.txt,.tsv"
            maxCount={1}
            showUploadList={false}
            disabled={忙}
            beforeUpload={(f) => {
              void 收文件(f);
              return false;
            }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">把 Excel 或 CSV 拖到这里</p>
            <p className="ant-upload-hint">
              收 .xlsx 和 .csv，最多 {行数上限.toLocaleString()} 行、{列数上限} 列。
              第一行是表头。文件不上传——在这台机器的浏览器里读完就直接落到你自己的库里
            </p>
          </Upload.Dragger>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 14 }}>
            只导{b.customer}这一张表。<b>手机号是认人的那一列</b>：同一个手机号算同一个人，
            所以没有手机号的行进不来。导完可以整批撤销。
          </Typography.Paragraph>
        </>
      )}

      {步 === 1 && (
        <对列
          {...{ 表头, 数据, 映射, set映射, 表, 认人列, 文件名, 截断了, b, 没对上的列, set没对上的列 }}
        />
      )}

      {步 === 2 && 看 && (
        <复核 {...{ 看, 改过, set改过, 表 }} />
      )}

      {步 === 3 && 看 && <确认 {...{ 看, 重复行, set重复行, b }} />}

      {步 === 4 && 结果 && (
        <div>
          <Alert
            type="success"
            showIcon
            title="导完了"
            description={`新建 ${结果.新建} 条，补空 ${结果.补空} 条，跳过 ${结果.跳过} 条，${结果.进不了} 条没进来。`}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 14 }}>
            导错了可以整批撤销：新建的删掉、补上的还原。
            <b>导入之后你已经动过的那几位会留着</b>，撤销时会告诉你是哪几位。
            这一批也能之后在「设置 → 数据」里找到。
          </Typography.Paragraph>
        </div>
      )}
    </Drawer>
  );
}

function 页脚({
  步, 忙, 认人列, 看, set步, 去预览, 落库, 撤, 重来, onClose,
}: {
  步: number; 忙: boolean; 认人列: number; 看: 预览 | null;
  set步: (n: number) => void; 去预览: () => void; 落库: () => void; 撤: () => void; 重来: () => void; onClose: () => void;
}) {
  if (步 === 0) return null;
  if (步 === 4)
    return (
      <Space style={{ display: "flex", justifyContent: "space-between" }}>
        <Button danger onClick={撤} loading={忙}>撤销这一批</Button>
        <Space>
          <Button onClick={重来}>再导一份</Button>
          <Button type="primary" onClick={() => { 重来(); onClose(); }}>完成</Button>
        </Space>
      </Space>
    );
  return (
    <Space style={{ display: "flex", justifyContent: "flex-end" }}>
      <Button onClick={() => set步(步 - 1)} disabled={忙}>上一步</Button>
      {步 === 1 && (
        <Button type="primary" onClick={去预览} loading={忙} disabled={认人列 < 0}>
          {认人列 < 0 ? "先指出手机号那一列" : "下一步"}
        </Button>
      )}
      {步 === 2 && <Button type="primary" onClick={() => set步(3)} disabled={忙}>下一步</Button>}
      {步 === 3 && (
        <Button type="primary" onClick={落库} loading={忙} disabled={!看 || 看.新建 + (看.补空 ?? 0) === 0}>
          开始导入
        </Button>
      )}
    </Space>
  );
}

/** 第二步：每一列对到哪个字段。**认人那一列没指出来就不让走**，见下面那条提示 */
function 对列({
  表头, 数据, 映射, set映射, 表, 认人列, 文件名, 截断了, b, 没对上的列, set没对上的列,
}: {
  表头: string[]; 数据: string[][]; 映射: (字段名 | null)[]; set映射: (m: (字段名 | null)[]) => void;
  表: ReturnType<typeof 字段表>; 认人列: number; 文件名: string; 截断了?: { 行?: number; 列?: number }; b: BusinessConfig;
  没对上的列: 导入方案["没对上的列"]; set没对上的列: (v: 导入方案["没对上的列"]) => void;
}) {
  const 选项 = [{ value: "", label: "没有对应字段" }, ...表.map((f) => ({ value: f.名, label: f.label + (f.必填 ? "（必填）" : "") }))];
  // 有表头、却没对上任何字段的那几列。没表头的不算——它并进备注也是一串没出处的值
  const 没对上 = 表头.filter((h, i) => !映射[i] && h.trim());
  const 没表头 = !像表头(表头);
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        读到了 <b>{文件名}</b>：{数据.length} 行、{表头.length} 列。左边是你表里的列，右边选它是什么。
      </Typography.Paragraph>
      {截断了 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="这份表太大，只取了前面一截"
          description={[
            截断了.行 ? `原表 ${截断了.行} 行，只读了前 ${行数上限} 行。` : "",
            截断了.列 ? `原表 ${截断了.列} 列，只读了前 ${列数上限} 列。` : "",
          ].join("")}
        />
      )}
      <Alert
        type={认人列 < 0 ? "warning" : "info"}
        showIcon
        style={{ marginBottom: 14 }}
        title={认人列 < 0 ? "手机号那一列必须指出来" : "手机号是认人的那一列"}
        description={
          认人列 < 0
            ? `没有它就没法判断表里这些人是不是已经在库里了，导第二次同一份表就是一整份重复数据。`
            : `同一个手机号算同一个${b.customer}。按姓名认人我们不做——重名就是把客户挂到别人名下。`
        }
      />
      {没表头 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          title="这份表好像没有表头——第一行就是第一个人"
          description={
            <span style={{ fontSize: 13 }}>
              第一行里有像电话号码的格子，而表头那一行不该有。
              照现在这样导，<b>第一行那个人会被当成表头吃掉</b>。
              请在 Excel 里最上面插一行、写上每列叫什么，再回来重导。
            </span>
          }
        />
      )}
      {没对上.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title={`有 ${没对上.length} 列没有对应的字段：${没对上.slice(0, 6).join("、")}${没对上.length > 6 ? " 等" : ""}`}
          description={
            <div style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 8 }}>
                我们不做自定义字段。这几列可以并进<b>备注</b>（写成「表头：值」一行一条），
                也可以直接不导——但那是看不见的损失：你会以为整份表都进来了。
              </div>
              <Space size={8}>
                <Switch
                  size="small"
                  checked={没对上的列 !== "丢掉"}
                  onChange={(v) => set没对上的列(v ? "并进备注" : "丢掉")}
                />
                <span>{没对上的列 !== "丢掉" ? "并进备注" : "不导，直接丢掉"}</span>
              </Space>
            </div>
          }
        />
      )}
      <Table
        size="small"
        pagination={false}
        rowKey="i"
        dataSource={表头.map((h, i) => ({ h, i }))}
        columns={[
          { title: "你表里的列", dataIndex: "h", width: 180, render: (h: string) => <b>{h || <Typography.Text type="secondary">（没有表头）</Typography.Text>}</b> },
          {
            title: "前三行长什么样",
            width: 280,
            render: (_: unknown, r: { i: number }) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {数据.slice(0, 3).map((d) => d[r.i]).filter(Boolean).join(" · ") || "（空）"}
              </Typography.Text>
            ),
          },
          {
            title: "导到哪个字段",
            width: 200,
            render: (_: unknown, r: { i: number }) => (
              <Select
                style={{ width: "100%" }}
                value={映射[r.i] ?? ""}
                options={选项.map((o) => ({
                  ...o,
                  // 一个字段只能有一列：已经被别的列占了的置灰，
                  // 两列都往同一个字段填的结果是后一列静悄悄覆盖前一列
                  disabled: o.value !== "" && 映射.some((m, j) => m === o.value && j !== r.i),
                }))}
                onChange={(v) => {
                  const m = [...映射];
                  m[r.i] = (v || null) as 字段名 | null;
                  set映射(m);
                }}
              />
            ),
          },
        ]}
      />
    </>
  );
}

/** 第三步：只列有问题的格子。**一列里同一个写法只让人改一次** */
function 复核({
  看, 改过, set改过, 表,
}: {
  看: 预览; 改过: Record<string, string>; set改过: (v: Record<string, string>) => void;
  表: ReturnType<typeof 字段表>;
}) {
  const 规格 = new Map(表.map((f) => [f.名, f]));
  if (看.待复核.length === 0 && 看.挡下.length === 0) {
    return <Empty description="每一格都读得懂，没有要你确认的" />;
  }
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        只列读不懂的格子。<b>一格读不懂不会让整行进不来</b>——那一格留空，其余照进。
        同一列里同一个写法改一次，那一列里所有这么写的行一起生效。
      </Typography.Paragraph>

      {看.挡下.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          title={`有 ${看.进不了} 行进不来`}
          description={
            <span style={{ fontSize: 13 }}>
              {看.挡下.slice(0, 5).map((x) => `第 ${x.行号} 行：${x.原因}`).join("；")}
              {看.挡下.length > 5 ? ` 等 ${看.进不了} 行` : ""}
            </span>
          }
        />
      )}

      {看.待复核.length > 0 && (
        <Table
          size="small"
          pagination={{ pageSize: 8, size: "small" }}
          rowKey={(r) => `${r.列}|${r.原值}`}
          dataSource={看.待复核}
          columns={[
            { title: "哪一列", dataIndex: "列名", width: 120 },
            {
              title: "表里写的",
              dataIndex: "原值",
              width: 140,
              render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
            },
            { title: "几行", dataIndex: "几行", width: 60 },
            {
              title: "会怎么处理",
              render: (_: unknown, r: 预览["待复核"][number]) => (
                <Space size={6}>
                  <Tag color={r.严重 === "拦行" ? "error" : r.严重 === "留空" ? "warning" : "default"}>
                    {r.严重 === "拦行" ? "这一行进不来" : r.严重 === "留空" ? "这一格留空" : "用默认值"}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.说法}</Typography.Text>
                </Space>
              ),
            },
            {
              title: "改成",
              width: 160,
              render: (_: unknown, r: 预览["待复核"][number]) => {
                const f = 规格.get(r.字段);
                if (f?.kind !== "enum") return <Typography.Text type="secondary" style={{ fontSize: 12 }}>回 Excel 里改</Typography.Text>;
                return (
                  <Select
                    style={{ width: "100%" }}
                    size="small"
                    allowClear
                    placeholder="用默认值"
                    value={改过[改动键(r.列, r.原值)]}
                    options={(f.values ?? []).map((v) => ({ value: v, label: v }))}
                    onChange={(v) => {
                      const next = { ...改过 };
                      if (v) next[改动键(r.列, r.原值)] = v;
                      else delete next[改动键(r.列, r.原值)];
                      set改过(next);
                    }}
                  />
                );
              },
            },
          ]}
        />
      )}
    </>
  );
}

/** 第四步：四个数 + 重复行怎么办。**这四个数就是真正会发生的**，不是估计 */
function 确认({
  看, 重复行, set重复行, b,
}: {
  看: 预览; 重复行: 导入方案["重复行"]; set重复行: (v: 导入方案["重复行"]) => void; b: BusinessConfig;
}) {
  return (
    <>
      <Space size={24} style={{ marginBottom: 18 }}>
        {[
          ["新建", 看.新建],
          [重复行 === "补空" ? "补空字段" : "跳过（已有）", 重复行 === "补空" ? 看.补空 : 看.跳过],
          ["进不来", 看.进不了],
        ].map(([k, v]) => (
          <div key={String(k)}>
            <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{v as number}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{k as string}</div>
          </div>
        ))}
      </Space>

      {看.合掉几行 > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title={`表里有 ${看.合掉几行} 行和前面的行是同一个手机号，已经合成一条`}
          description="后面那几行只补前面没填的格子，不覆盖。上面这几个数已经是合并之后的，不是估计。"
        />
      )}

      <Typography.Title level={5} style={{ fontSize: 14, marginBottom: 8 }}>
        手机号已经在库里的那些行怎么办
      </Typography.Title>
      <Radio.Group value={重复行} onChange={(e) => set重复行(e.target.value)} style={{ display: "block" }}>
        <Radio value="跳过" style={{ display: "block", marginBottom: 10 }}>
          <b>跳过</b>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>一个字都不动。不确定表里哪一份新时选它</div>
        </Radio>
        <Radio value="补空" style={{ display: "block" }}>
          <b>只补空着的字段</b>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            库里那格是空的才填，已经有值的一律不动。没有「覆盖」这个选项——
            人录过的东西不该被一份表刷掉。来源渠道也不动：那会让一位{b.customer}静默换主
          </div>
        </Radio>
      </Radio.Group>
    </>
  );
}
