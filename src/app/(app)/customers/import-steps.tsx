"use client";

import { Alert, Button, Checkbox, Empty, Input, Popconfirm, Radio, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { 行数上限, 列数上限 } from "@/lib/import/parse";
import { 字段表, 像表头, type 字段名 } from "@/lib/import/fields";
import { 改动键 } from "@/lib/import/plan";
import { 粘贴字数上限, type 编造格, type 粘贴结果 } from "@/lib/import/paste";
import { 样例行数 } from "@/lib/jev/columns";
import type { 预览, 导入方案 } from "./import-actions";
import { 外贸精简, type BusinessConfig } from "@/lib/business-config";
import AiWait from "@/components/AiWait";

/**
 * 报第几行时怎么说（审查 D15）。行号按文件那条路算（1 是表头，第一条数据是 2，人照着去 Excel 里找）；
 * 可粘贴那条路没有人看得见的表头——上面写「读到了粘贴的文本（3 行）」，警告里却说「第 4 行」。
 * 粘贴的就按人看到的第几条说。
 */
export function 第几行(行号: number, 粘贴: boolean): string {
  return 粘贴 ? `第 ${行号 - 1} 条` : `第 ${行号} 行`;
}

/** 导入抽屉（ImportDrawer.tsx）的各一步：粘贴、对列、复核、确认，外加页脚那排按钮。流程和状态在抽屉里 */

export function 页脚({
  步, 忙, 认人列, 看, set步, 去预览, 落库, 撤, 重来, 完成, 这一批, 客户叫法, 认人叫法 = "手机号", 原文未确认 = false,
}: {
  步: number; 忙: boolean; 认人列: number; 看: 预览 | null;
  /** 第 1 步那个灰按钮上的「先指出 X 那一列」：外贸是「电话、WhatsApp 或邮箱」 */
  认人叫法?: string;
  原文未确认?: boolean;
  set步: (n: number) => void; 去预览: () => void; 落库: () => void; 撤: () => void; 重来: () => void;
  /** 点「完成」：收起抽屉，列表只显示这一批（审查 D10） */
  完成: () => void;
  /** 刚导进来的这一批：新建几条、补空几条。撤销的确认里要写清会动哪些 */
  这一批: { 新建: number; 补空: number } | null;
  /** 撤销确认里用工作区自己的叫法（第 2 期 2a）：原来写「条新建的记录」 */
  客户叫法: string;
}) {
  if (步 === 0) return null;
  if (步 === 4)
    return (
      <Space style={{ display: "flex", justifyContent: "space-between" }}>
        {/* 整批撤销一次动很多条，和「设置 → 导入记录」里同一个确认（审查 M15）。原来一点就删 */}
        <Popconfirm
          title="撤销这一批导入？"
          description={`会删掉这一批新建的 ${这一批?.新建 ?? 0} 位${客户叫法}${这一批?.补空 ? `、还原 ${这一批.补空} 位补过空的` : ""}。导入之后改过档案、记过跟进的那几位会留着。`}
          okText="撤销"
          okButtonProps={{ danger: true }}
          cancelText="不了"
          onConfirm={撤}
        >
          <Button danger loading={忙}>撤销这一批</Button>
        </Popconfirm>
        <Space>
          <Button onClick={重来}>再导一份</Button>
          <Button type="primary" onClick={完成}>完成</Button>
        </Space>
      </Space>
    );
  return (
    <Space style={{ display: "flex", justifyContent: "flex-end" }}>
      <Button onClick={() => set步(步 - 1)} disabled={忙}>上一步</Button>
      {步 === 1 && (
        <Button type="primary" onClick={去预览} loading={忙} disabled={认人列 < 0 || 原文未确认}>
          {认人列 < 0 ? `先指出${认人叫法}那一列` : "下一步"}
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
export function 粘贴面板({
  原文, set原文, 忙, aiEnabled, 整理, 进度, b,
}: {
  原文: string; set原文: (v: string) => void; 忙: boolean; aiEnabled: boolean; 整理: () => void;
  进度: { 起: number; 出错?: string } | null; b: BusinessConfig;
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
          {进度 ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <AiWait
                在做={`把这 ${原文.length.toLocaleString()} 字切成一行一${称呼}，每一格都对回原文`}
                起={进度.起}
                出错={进度.出错}
              />
            </div>
          ) : (
            <Typography.Text type={超了 ? "danger" : "secondary"} style={{ fontSize: 12 }}>
              {超了
                ? `超了 ${(原文.length - 粘贴字数上限).toLocaleString()} 字。再多请存成 Excel 走「文件」那条路`
                : `${原文.length.toLocaleString()} / ${粘贴字数上限.toLocaleString()} 字`}
            </Typography.Text>
          )}
          {/* 跑着时不转圈：在做什么、过了几秒，左边那一行已经说了。按钮只负责「现在不能再点」 */}
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            disabled={忙 || !aiEnabled || !原文.trim() || 超了}
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
          长名单按原文行分批处理；失败会保留已完成批次，再点整理只继续剩余部分。修改原文则重新开始。
          <br />
          原文里找不到的格子会被清空并列给你；原文里有、表里没有的手机号也会列出来，
          那多半是有人被漏掉了。
          <br />
          <b>要按上面那颗按钮才跑</b>，一次花一次 AI 次数。文本会发给 AI 模型：默认经我们的模型网关转给模型商（网关不存内容），在设置里填了自己 Key 的直接发给你配的模型商。
        </Typography.Paragraph>
      )}
    </>
  );
}

/** 第二步：每一列对到哪个字段。**认人那一列没指出来就不让走**，见下面那条提示 */
export function 对列({
  表头, 数据, 映射, set映射, 表, 认人列, 文件名, 截断了, b, 没对上的列, set没对上的列, 编造, 漏掉, AI认列, 原文复核,
}: {
  表头: string[]; 数据: string[][]; 映射: (字段名 | null)[]; set映射: (m: (字段名 | null)[]) => void;
  表: ReturnType<typeof 字段表>; 认人列: number; 文件名: string; 截断了?: { 行?: number; 列?: number }; b: BusinessConfig;
  没对上的列: 导入方案["没对上的列"]; set没对上的列: (v: 导入方案["没对上的列"]) => void;
  编造: 编造格[]; 漏掉: string[];
  原文复核?: Pick<粘贴结果, "关联" | "未覆盖"> & { 原文: string; 已确认: boolean; 确认: (v: boolean) => void };
  /**
   * 「让 AI 认一下」（L-076）。不给 = 这个部署没接判断模型、或管理员没打开「导入时让 AI 认列」，就不摆按钮。
   * 点了才发，按钮旁边一句话说清发什么
   */
  AI认列?: { 跑: () => void; 忙: boolean };
}) {
  const 选项 = [{ value: "", label: "没有对应字段" }, ...表.map((f) => ({ value: f.名, label: f.label + (f.必填 ? "（必填）" : "") }))];
  /*
    没对上任何字段的那几列。没表头、但数据里有值的也算，叫「第 N 列」——plan.ts 照这个出处并进备注（2026-10-04 J-056）；
    不列出来的话，人既不知道它们会进备注，也找不到「不导」那个开关
  */
  const 没对上 = 表头.flatMap((h, i) =>
    映射[i] ? [] : h.trim() ? [h.trim()] : 数据.some((r) => (r[i] ?? "").trim()) ? [`第 ${i + 1} 列`] : [],
  );
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
        title={认人列 < 0 ? (外贸精简(b) ? "电话、WhatsApp、邮箱至少指出一列" : "手机号那一列必须指出来") : 外贸精简(b) ? "电话是认人的那一列，没有电话拿 WhatsApp、再没有拿邮箱" : "手机号是认人的那一列"}
        description={
          认人列 < 0
            ? `没有它就没法判断表里这些人是不是已经在库里了，导第二次同一份表就是一整份重复数据。`
            : 外贸精简(b)
              ? `同一个号码（或没有号码时同一个邮箱）算同一个${b.customer}。按姓名认人我们不做——重名就是把客户挂到别人名下。`
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
              {编造.slice(0, 5).map((x) => `${第几行(x.行号, true)}「${x.列名}」写的是「${x.值}」`).join("；")}
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
      {原文复核 && (
        <section aria-label="粘贴原文复核" style={{ marginBottom: 16 }}>
          <Alert type="warning" showIcon title="逐条对照原文后再继续"
            description="文字在原文里出现过，不代表姓名、号码和公司属于同一人。下面的定位只是核对线索；跨行、同段多人及单字姓名会标为待核对。发现错配或遗漏，请回上一步分人分行修改原文后重新整理。" />
          <details style={{ margin: "12px 0" }}>
            <summary>查看完整原文</summary>
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{原文复核.原文}</pre>
          </details>
          {原文复核.未覆盖.length > 0 && <Alert type="warning" title={`有 ${原文复核.未覆盖.length} 段原文未完整关联到表格，请检查是否漏人`}
            description={<details><summary>展开未覆盖的原文（也可能是标题或说明）</summary>
              {原文复核.未覆盖.map((p) => <div key={p.行号}>原文第 {p.行号} 行：{p.文本}</div>)}
            </details>} />}
          <Table size="small" rowKey="行号" pagination={{ pageSize: 10, showSizeChanger: false }}
            dataSource={原文复核.关联} style={{ margin: "12px 0" }} columns={[
              { title: "整理结果", render: (_, r) => <div>第 {r.行号 - 1} 条：{数据[r.行号 - 2]?.filter(Boolean).join(" · ")}</div> },
              { title: "原文定位", render: (_, r) => <div>{r.待核对 && <Tag color="warning">关联待核对</Tag>}
                {r.原文.map((p) => <div key={p.行号}>第 {p.行号} 行：{p.文本}</div>)}
                {!r.原文.length && "没有找到同段原文，请核对"}</div> },
            ]} />
          <Checkbox checked={原文复核.已确认} onChange={(e) => 原文复核.确认(e.target.checked)}>
            我已逐条核对姓名、联系方式、公司及遗漏提示，确认继续导入这份结果
          </Checkbox>
        </section>
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
              {AI认列 && (
                <div style={{ marginTop: 10 }}>
                  <Button size="small" icon={<ThunderboltOutlined />} loading={AI认列.忙} onClick={AI认列.跑}>
                    让 AI 认一下这 {没对上.length} 列
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    会把这几列的表头和前 {样例行数} 行发给 AI，其余行不发；认出来的只是下面的默认选项，你还要自己看一眼
                  </Typography.Text>
                </div>
              )}
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
export function 复核({
  看, 改过, set改过, 表, 粘贴 = false,
}: {
  看: 预览; 改过: Record<string, string>; set改过: (v: Record<string, string>) => void;
  表: ReturnType<typeof 字段表>;
  /** 这张表是粘贴的文本整理出来的：报行号时按第几条说 */
  粘贴?: boolean;
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
              {看.挡下.slice(0, 5).map((x) => `${第几行(x.行号, 粘贴)}：${x.原因}`).join("；")}
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
                    {r.严重 === "拦行" ? "这一行进不来" : r.严重 === "留空" ? "这一格留空" : r.严重 === "照收" ? "按原样导入" : "用默认值 · 原文进备注"}
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

/**
 * 按眼下选的「重复行」处置重算 补空 / 跳过。预览只在第 2 步算一次（当时默认「跳过」），
 * 人到第 4 步改成「只补空」不重算的话：界面写「补空 0」，表里的人全在库里时「开始导入」一直是灰的（2026-10-02 排查）
 */
export function 按处置(看: 预览, 重复行: 导入方案["重复行"]): 预览 {
  return { ...看, 补空: 重复行 === "补空" ? 看.已在库里 : 0, 跳过: (重复行 === "补空" ? 0 : 看.已在库里) + 看.说不清 };
}

/** 第四步：四个数 + 重复行怎么办。**这四个数就是真正会发生的**，不是估计 */
export function 确认({
  看, 重复行, set重复行, b,
}: {
  看: 预览; 重复行: 导入方案["重复行"]; set重复行: (v: 导入方案["重复行"]) => void; b: BusinessConfig;
}) {
  /**
   * 表里的号码有几位已经在库里。两种处置下 跳过 + 补空 都是这个数（见 import-actions 的 预览）。
   * 一位都没有时，「跳过 / 只补空」这道题和那段解释整块不出现（审查 D10）——问一个不存在的情况只是添堵
   */
  const 已有 = 看.跳过 + 看.补空;
  return (
    <>
      <Space size={24} style={{ marginBottom: 18 }}>
        {([
          ["新建", 看.新建],
          ...(已有 > 0 ? [[重复行 === "补空" ? "补空字段" : "跳过（已有）", 重复行 === "补空" ? 看.补空 : 看.跳过]] : []),
          ["进不来", 看.进不了],
        ] as [string, number][]).map(([k, v]) => (
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
          title={`表里有 ${看.合掉几行} 行和前面的行是同一个${外贸精简(b) ? "人（号码或邮箱一样）" : "手机号"}，已经合成一条`}
          description="后面那几行只补前面没填的格子，不覆盖；备注不丢，添在后面。上面这几个数已经是合并之后的，不是估计。"
        />
      )}

      {已有 > 0 && (<>
      <Typography.Title level={5} style={{ fontSize: 14, marginBottom: 8 }}>
        {外贸精简(b) ? "已经在库里的那些行怎么办" : "手机号已经在库里的那些行怎么办"}
      </Typography.Title>
      {/* 竖排靠 Group 的 flex，不给 Radio 设 display:block——那会把圆点和字拆成两行、说明文字冲出抽屉（核对教程时看到的） */}
      <Radio.Group value={重复行} onChange={(e) => set重复行(e.target.value)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Radio value="跳过">
          <b>跳过</b>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>一个字都不动。不确定表里哪一份新时选它</div>
        </Radio>
        <Radio value="补空">
          <b>只补空着的字段</b>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            库里那格是空的才填，已经有值的一律不动；表里我们没有的列（比如微信号）添在备注后面。没有「覆盖」这个选项——
            人录过的东西不该被一份表刷掉。来源渠道也不动：那会让一位{b.customer}静默换主
          </div>
        </Radio>
      </Radio.Group>
      </>)}
    </>
  );
}
