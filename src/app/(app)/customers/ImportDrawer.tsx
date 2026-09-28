"use client";

import { useMemo, useRef, useState } from "react";
import { App, Alert, Drawer, Segmented, Steps, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { 解析CSV, 成表, 行数上限, 列数上限 } from "@/lib/import/parse";
import { 字段表, 猜列, type 字段名 } from "@/lib/import/fields";
import { type 编造格 } from "@/lib/import/paste";
import { 并进来, 样例行数 } from "@/lib/jev/columns";
import { 预览导入, 执行导入, 撤销批次, type 预览, type 导入方案 } from "./import-actions";
import { 粘成表格, 猜列建议 } from "./ai";
import type { BusinessConfig } from "@/lib/business-config";
import { 页脚, 粘贴面板, 对列, 复核, 确认 } from "./import-steps";
import { clearJob, runJob } from "@/lib/ai-jobs";

/** 粘贴整理那一次在任务表里的 key。同一时刻只会有一个抽屉在导 */
const 整理任务键 = "import:paste";

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
  /**
   * 粘贴整理走到哪儿了。这一次调用最长要等两分钟（ai.ts 里给了 120 秒），
   * 原来只有按钮上一个圈——人不知道它在干什么、是不是卡住了。现在按钮旁边一行说清楚，
   * 同时登记进任务表：人切去别的应用，好了侧栏和系统通知会叫他。
   */
  const [整理, set整理] = useState<{ 起: number; 出错?: string } | null>(null);
  /** 抽屉在整理途中被关掉 / 重来：回来的表没人接，不许再往一个已经重来的抽屉里填 */
  const 这一次 = useRef(0);
  const [结果, set结果] = useState<{ batchId: string; 新建: number; 补空: number; 跳过: number; 进不了: number } | null>(null);

  const 方案 = (): 导入方案 => ({ 表头, 数据, 映射, 改过, 重复行, 没对上的列 });

  function 重来() {
    这一次.current++;
    clearJob(整理任务键);
    set整理(null);
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
  async function 整理成表() {
    const 轮 = ++这一次.current;
    const 起 = Date.now();
    set整理({ 起 });
    set忙(true);
    const 请求 = 粘成表格(原文);
    // 任务表只记「跑着 / 好了 / 出错」给侧栏和系统通知用；表本身由下面这条 await 接
    runJob<null>(
      整理任务键,
      () => 请求.then((r) => (r.ok ? { ok: true as const, value: null } : { ok: false as const, error: r.error })),
      undefined,
      { 名: "把粘贴的文本整理成表", 去: "/customers" },
    );
    try {
      const r = await 请求;
      if (轮 !== 这一次.current) return;
      // 出错写在原地那一行，红字留着——原来是一条几秒就走的提示，人回头看时已经不知道刚才怎么了
      if (!r.ok) return set整理({ 起, 出错: r.error });
      set整理(null);
      set编造(r.编造);
      set漏掉(r.漏掉);
      收表(`粘贴的文本（${r.数据.length} 行）`, r.表头, r.数据, r.截断了);
    } catch (e) {
      if (轮 !== 这一次.current) return;
      set整理({ 起, 出错: e instanceof Error ? e.message : "整理失败，请重试" });
    } finally {
      // 不管这一轮还算不算数都要放开：关掉再打开时按钮不能还灰着
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
            <粘贴面板 {...{ 原文, set原文, 忙, aiEnabled, 整理: 整理成表, 进度: 整理, b }} />
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
