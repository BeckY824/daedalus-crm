"use client";

import { useMemo, useState } from "react";
import { App, Alert, Button, Drawer, Empty, Input, Radio, Segmented, Select, Space, Steps, Switch, Table, Tag, Typography, Upload } from "antd";
import { InboxOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { 解析CSV, 成表, 行数上限, 列数上限 } from "@/lib/import/parse";
import { 字段表, 猜列, 像表头, type 字段名 } from "@/lib/import/fields";
import { 改动键 } from "@/lib/import/plan";
import { 粘贴字数上限, type 编造格 } from "@/lib/import/paste";
import { 并进来, 样例行数 } from "@/lib/jev/columns";
import { 预览导入, 执行导入, 撤销批次, type 预览, type 导入方案 } from "./import-actions";
import { 粘成表格, 猜列建议 } from "./ai";
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
 * ## 三个来路，一条管线
 *
 * csv、xlsx、粘一段文本，三条路都在第一步里收成同一个二维数组，
 * **从第二步「对列」往后只有一套逻辑**。两套管线的下场是复核、预览、撤销
 * 各写两遍，其中一遍迟早落后。
 *
 * xlsx 的解析器在 lib/import/xlsx.ts，按需加载——它带着 fflate，
 * 只导 csv 的人不该为此多下一份 js。粘贴那条路要过一次模型（lib/import/paste.ts
 * 出提示词和核对，ai.ts 发那一次调用），**但模型的活儿只到「切成行和列」为止**：
 * 切完的表和从 Excel 读出来的那个数组长得一模一样，日期怎么认、状态怎么对、
 * 重复怎么并，全都还是下游那几个纯函数说了算。
 *
 * ## 粘贴那条路上 AI 不自动跑
 *
 * 粘进去不会有任何事发生，要人自己按「整理成表格」。这一次调用花钱、占次数，
 * 而人往输入框里粘东西太便宜了——边想边粘、粘错了重粘都是常事。
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
  aiEnabled,
  onDone,
  初始来路,
  初始文本,
}: {
  open: boolean;
  onClose: () => void;
  b: BusinessConfig;
  /** 接上模型了没有。没接上时「粘一段文本」那条路只说明原因，不给按钮 */
  aiEnabled: boolean;
  onDone: () => void;
  /**
   * 开门停在哪一栏。**「粘」是主线入口**（2026-09-21）：首页认出你粘的是一段聊天时，
   * 直接把人送到这一栏，而不是先落到「文件」上再让人自己找。
   */
  初始来路?: "文件" | "文本";
  /**
   * 开门时就把这段文本填好。首页那一下粘的是全文——
   * 输入框里那份被 maxLength 截过，所以必须由调用方把全文递进来。
   */
  初始文本?: string;
}) {
  const { message, modal } = App.useApp();
  const 表 = useMemo(() => 字段表(b), [b]);

  const [步, set步] = useState(0);
  const [来路, set来路] = useState<"文件" | "文本">("文件");
  const [原文, set原文] = useState("");
  /** 模型编出来、已经被清空的格子。只在粘贴那条路上会有 */
  const [编造, set编造] = useState<编造格[]>([]);
  /** 原文里有、整理出来的表里却没有的手机号 */
  const [漏掉, set漏掉] = useState<string[]>([]);
  const [文件名, set文件名] = useState("");

  /**
   * 开门时按调用方说的停在哪一栏、填好哪段文本。
   *
   * **不用 effect**：effect 里 setState 是「先画一遍旧的、再画一遍新的」，
   * 抽屉会当着人的面从「文件」跳到「文本」。这是 React 文档里那条
   * 「props 变了要调整 state」的写法——在渲染中比对上一次的值，当场改完再画。
   *
   * 只在 open 从假变真那一下做：关掉之后调用方多半会把 `初始文本` 清成空串，
   * 而那时人可能已经在框里改过字了，跟着 props 一路同步会把他改的抹掉。
   */
  const [上次open, set上次open] = useState(open);
  if (open !== 上次open) {
    set上次open(open);
    if (open) {
      if (初始来路) set来路(初始来路);
      if (初始文本) set原文(初始文本);
    }
  }
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
    set来路("文件");
    set原文("");
    set编造([]);
    set漏掉([]);
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
      收表(f.name, t.表头, t.数据, t.截断了);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "这个文件读不出来");
    } finally {
      set忙(false);
    }
  }

  /**
   * 三条来路在这里汇合。**从这一行往后不再区分文件还是文本**——
   * 猜列、复核、预览、落库、撤销看到的都是同一个二维数组。
   */
  function 收表(名: string, h: string[], d: string[][], 切了?: { 行?: number; 列?: number }) {
    set文件名(名);
    set表头(h);
    set数据(d);
    set截断了(切了);
    const 规则 = 猜列(h, 表);
    set映射(规则);
    set改过({});
    set步(1);
    void 补猜(h, d, 规则);
  }

  /**
   * 规则认不出来的那几列，再问一次判断模型。
   *
   * **不 await、不转圈、不拦路。** 规则的结果已经摆在界面上了，人可以立刻开始复核；
   * 这一趟回来只往还空着的格子里填。回不来（没配 key、关了开关、断网、超时）就什么都不发生，
   * 界面停在规则给出的样子——那正是 2026-09-20 之前的样子，不是坏掉。
   *
   * 合并用 `并进来` 而不是直接 set：这一秒多里人可能已经手动选了某一列，
   * 那一列必须赢。同一个字段被两列同时命中也在那儿去重——模型是一列一问、
   * 彼此看不见的，「联系方式」和「TEL」它会都判成 phone。
   */
  async function 补猜(h: string[], d: string[][], 规则: (字段名 | null)[]) {
    try {
      const 答案 = await 猜列建议(h, d.slice(0, 样例行数), 规则);
      if (答案) set映射((prev) => 并进来(prev, 答案, 表));
    } catch {
      // 兜底的兜底：这一层坏了也只是少猜几列，不该让导入报错
    }
  }

  /** 粘贴那条路：按了按钮才跑。跑完先让人看见这张表，确认无误再往下走 */
  async function 整理() {
    set忙(true);
    try {
      const r = await 粘成表格(原文);
      if (!r.ok) return message.error(r.error);
      set编造(r.编造);
      set漏掉(r.漏掉);
      收表(`粘贴的文本（${r.数据.length} 行）`, r.表头, r.数据, r.截断了);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "整理失败，请重试");
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
          <Segmented
            block
            value={来路}
            onChange={(v) => set来路(v as "文件" | "文本")}
            options={["文件", "粘一段文本"].map((x) => ({ value: x === "文件" ? "文件" : "文本", label: x }))}
            style={{ marginBottom: 16 }}
          />
          {来路 === "文本" ? (
            <粘贴面板 {...{ 原文, set原文, 忙, aiEnabled, 整理, b }} />
          ) : (
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
        </>
      )}

      {步 === 1 && (
        <对列
          {...{ 表头, 数据, 映射, set映射, 表, 认人列, 文件名, 截断了, b, 没对上的列, set没对上的列, 编造, 漏掉 }}
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

/**
 * 第一步的另一条路：粘一段文本。
 *
 * 输入框是哑的——`onChange` 只存字，不触发任何调用。要人按下那颗按钮才走一次模型
 * （见文件头「AI 不自动跑」）。按钮在没接模型、没粘东西、粘超了三种情况下都是灰的，
 * 每一种旁边都写着为什么，而不是灰在那儿让人猜。
 */
function 粘贴面板({
  原文, set原文, 忙, aiEnabled, 整理, b,
}: {
  原文: string; set原文: (v: string) => void; 忙: boolean; aiEnabled: boolean; 整理: () => void; b: BusinessConfig;
}) {
  const 称呼 = b.customer;
  const 超了 = 原文.length > 粘贴字数上限;
  /**
   * 一段能直接点来用的例子。**空白页是第一次用的人最容易退出去的地方**——
   * 他手上不一定正好有一段聊天，而「粘一段」这件事光靠一句提示说不清楚。
   * 内容是编的、明显是样例（远山资本 / 平川科技），不会和真数据混。
   */
  const 例子 = [
    "老王 13800001111 远山资本，昨天见过面，说预算要等下个季度",
    "@李娜 138-0000-2222 平川科技 已经加微信，让我周三再联系一次",
    "还有个张总，手机 13700002222，他是老王介绍过来的，暂时只是了解",
  ].join("\n");
  return (
    <>
      <div style={{ background: "var(--brand-bg)", border: "1px solid var(--brand-line)", borderRadius: 8, padding: "12px 14px" }}>
        <Input.TextArea
          value={原文}
          onChange={(e) => set原文(e.target.value)}
          autoSize={{ minRows: 8, maxRows: 18 }}
          disabled={忙 || !aiEnabled}
          placeholder={`把${称呼}名单、群接龙、会议纪要，或者一段微信聊天记录粘进来。\n不用整理成表格，怎么来的就怎么粘。\n\n如：\n王强 13800001111 远山资本 下周三再聊\n李娜，手机 138-0000-2222，平川科技，已经加了微信`}
        />
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          {!原文.trim() && aiEnabled && (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => set原文(例子)}>
              没有现成的？先看个例子
            </Button>
          )}
          <Typography.Text type={超了 ? "danger" : "secondary"} style={{ fontSize: 12 }}>
            {超了
              ? `超了 ${(原文.length - 粘贴字数上限).toLocaleString()} 字。再多请存成 Excel 走「文件」那条路`
              : `${原文.length.toLocaleString()} / ${粘贴字数上限.toLocaleString()} 字`}
          </Typography.Text>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={忙}
            disabled={!aiEnabled || !原文.trim() || 超了}
            onClick={整理}
          >
            整理成表格
          </Button>
        </div>
      </div>

      {!aiEnabled ? (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14 }}
          title="这条路要先接上模型"
          description={
            <span style={{ fontSize: 13 }}>
              到「设置 → AI 接入」填上接口地址和 API Key 就能用。
              在那之前，<b>从「文件」那条路导 Excel 或 CSV 一样能用</b>，而且不花钱、不走网络。
            </span>
          }
        />
      ) : (
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 14, marginBottom: 0 }}>
          AI 只做一件事：把这段文本<b>切成行和列</b>，每一格都是原文里的原字——不改写、不补全、
          不把「下周三」算成哪一天。切完先给你看，确认无误再往下走。
          <br />
          原文里找不到的格子会被清空并列给你；原文里有、表里没有的手机号也会列出来，
          那多半是有人被漏掉了。
          <br />
          <b>要按上面那颗按钮才跑</b>，一次花一次 AI 次数。文本不传给我们，只发给你自己配的那个模型。
        </Typography.Paragraph>
      )}
    </>
  );
}

/** 第二步：每一列对到哪个字段。**认人那一列没指出来就不让走**，见下面那条提示 */
function 对列({
  表头, 数据, 映射, set映射, 表, 认人列, 文件名, 截断了, b, 没对上的列, set没对上的列, 编造, 漏掉,
}: {
  表头: string[]; 数据: string[][]; 映射: (字段名 | null)[]; set映射: (m: (字段名 | null)[]) => void;
  表: ReturnType<typeof 字段表>; 认人列: number; 文件名: string; 截断了?: { 行?: number; 列?: number }; b: BusinessConfig;
  没对上的列: 导入方案["没对上的列"]; set没对上的列: (v: 导入方案["没对上的列"]) => void;
  编造: 编造格[]; 漏掉: string[];
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
      {/*
        下面这两条只会在粘贴那条路上出现，是 lib/import/paste.ts 里那两条核对的结果。
        它们摆在这一步、摆在表格上面，因为这是人第一次看见模型切出来的东西——
        等到第三步「复核」再说就晚了：那一屏说的是「这一格读不懂」，
        而这两条说的是「这一格根本不该存在」和「这个人不见了」，不是一回事。
      */}
      {编造.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          title={`有 ${编造.length} 格是 AI 编的，已经清空`}
          description={
            <span style={{ fontSize: 13 }}>
              这些字在你粘的原文里找不到：
              {编造.slice(0, 5).map((x) => `第 ${x.行号} 行「${x.列名}」写的是「${x.值}」`).join("；")}
              {编造.length > 5 ? ` 等 ${编造.length} 格` : ""}。
              <b>已经按空着处理</b>，不会进库。原文里确实有的话，回上一步补进去再整理一次。
            </span>
          }
        />
      )}
      {漏掉.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          title={`原文里有 ${漏掉.length} 个手机号没进这张表`}
          description={
            <span style={{ fontSize: 13 }}>
              {漏掉.slice(0, 5).join("、")}
              {漏掉.length > 5 ? ` 等 ${漏掉.length} 个` : ""}。
              这几个人很可能被漏掉了——<b>照现在这样导，他们不会进来</b>。
              回上一步把他们那几行单独粘一次，或者存成 Excel 走文件那条路。
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
                  {/* 「照收」不是问题是提示：值不在选项里，但这个字段开放，原样写进去。
                      漏了这一档的话它会掉进兜底，显示成「用默认值」——正好说反 */}
                  <Tag color={r.严重 === "拦行" ? "error" : r.严重 === "留空" ? "warning" : r.严重 === "照收" ? "blue" : "default"}>
                    {r.严重 === "拦行" ? "这一行进不来" : r.严重 === "留空" ? "这一格留空" : r.严重 === "照收" ? "按原样导入" : "用默认值"}
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
