/**
 * 生成《CRM 客户管理系统 · 产品功能说明书》Word 文档。
 *
 *   node scripts/shoot.mjs      # 先抓截图
 *   node scripts/build-doc.mjs  # 再生成文档
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  BorderStyle,
  PageBreak,
  LevelFormat,
  Footer,
  PageNumber,
  Tab,
  TabStopType,
  LeaderType,
} from "docx";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const SHOTS = path.resolve("docs/shots");
const OUT = path.resolve("docs/CRM客户管理系统-产品功能说明书.docx");

/* ---------- 版式常量（DXA，1440 = 1 英寸） ---------- */
const PAGE_W = 11906; // A4 宽
const MARGIN = 1080; // 0.75 英寸
const CONTENT_W = PAGE_W - MARGIN * 2; // 正文可用宽度 9746

const BRAND = "1668DC";
const INK = "10233D";
const MUTED = "64748B";
const RULE = "E4EBF3";

/* ---------- 小工具 ---------- */

const P = (text, opts = {}) =>
  new Paragraph({
    spacing: { before: opts.before ?? 0, after: opts.after ?? 140, line: 300 },
    alignment: opts.align,
    children: [
      new TextRun({
        text,
        size: opts.size ?? 21, // half-points → 10.5pt
        color: opts.color ?? "2B3A4F",
        bold: opts.bold,
        italics: opts.italics,
      }),
    ],
  });

const H1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 200 },
    children: [new TextRun({ text, size: 32, bold: true, color: INK })],
  });

const H2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 140 },
    children: [new TextRun({ text, size: 25, bold: true, color: INK })],
  });

const BULLET = (text, bold) =>
  new Paragraph({
    numbering: { reference: "dot", level: 0 },
    spacing: { after: 90, line: 300 },
    children: bold
      ? [
          new TextRun({ text: bold, size: 21, bold: true, color: INK }),
          new TextRun({ text: "　" + text, size: 21, color: "2B3A4F" }),
        ]
      : [new TextRun({ text, size: 21, color: "2B3A4F" })],
  });

/** 分隔线（用段落下边框，不要用表格伪装） */
const RULE_P = () =>
  new Paragraph({
    spacing: { before: 60, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
    children: [new TextRun({ text: "", size: 2 })],
  });

/** 插图 + 图注。按内容宽度等比缩放 */
function figure(fileBase, caption, wPx = 600) {
  const file = path.join(SHOTS, `${fileBase}.png`);
  if (!existsSync(file)) {
    console.warn("缺少截图：", file);
    return [P(`（截图缺失：${fileBase}）`, { color: MUTED, italics: true })];
  }
  // 截图为 3360×2100（2 倍图），按原始比例缩放，避免变形
  const hPx = Math.round((wPx * 2100) / 3360);
  return [
    new Paragraph({
      spacing: { before: 60, after: 60 },
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type: "png",
          data: readFileSync(file),
          transformation: { width: wPx, height: hPx },
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 220 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: caption, size: 18, color: MUTED })],
    }),
  ];
}

/**
 * 目录条目。用静态文本而非 TOC 域：
 * 域需要在 Word 里手动按 F9 才会填充，直接发给客户会看到空白目录页。
 * 页码取自最终排版结果，改动正文后需同步更新（见 TOC 数组注释）。
 */
const tocLine = (text, page, sub) =>
  new Paragraph({
    spacing: { after: sub ? 60 : 90, line: 280 },
    indent: sub ? { left: 420 } : undefined,
    // 右对齐制表位 + 点线引导，Word 与 LibreOffice 均支持
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W, leader: LeaderType.DOTS }],
    children: [
      new TextRun({
        text,
        size: sub ? 20 : 21,
        bold: !sub,
        color: sub ? "2B3A4F" : INK,
      }),
      new TextRun({
        children: [new Tab(), String(page)],
        size: sub ? 20 : 21,
        color: sub ? MUTED : INK,
      }),
    ],
  });

/** 双列信息表：左窄右宽 */
function infoTable(rows, leftW = 2000) {
  const rightW = CONTENT_W - leftW;
  return new Table({
    columnWidths: [leftW, rightW],
    width: { size: CONTENT_W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    },
    rows: rows.map(
      ([k, v]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: leftW, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: "F7FAFD", color: "auto" },
              margins: { top: 90, bottom: 90, left: 140, right: 140 },
              children: [
                new Paragraph({
                  spacing: { after: 0, line: 280 },
                  children: [new TextRun({ text: k, size: 20, bold: true, color: INK })],
                }),
              ],
            }),
            new TableCell({
              width: { size: rightW, type: WidthType.DXA },
              margins: { top: 90, bottom: 90, left: 140, right: 140 },
              children: [
                new Paragraph({
                  spacing: { after: 0, line: 280 },
                  children: [new TextRun({ text: v, size: 20, color: "2B3A4F" })],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

/** 带表头的多列表格 */
function gridTable(head, rows, widths) {
  const mk = (text, bold, fill) =>
    new TableCell({
      width: { size: widths[0], type: WidthType.DXA },
      shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
      margins: { top: 90, bottom: 90, left: 130, right: 130 },
      children: [
        new Paragraph({
          spacing: { after: 0, line: 280 },
          children: [
            new TextRun({ text, size: 19, bold, color: bold ? "FFFFFF" : "2B3A4F" }),
          ],
        }),
      ],
    });

  const cell = (text, i, bold, fill) => {
    const c = mk(text, bold, fill);
    c.options.width = { size: widths[i], type: WidthType.DXA };
    return c;
  };

  return new Table({
    columnWidths: widths,
    width: { size: CONTENT_W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: head.map((h, i) => cell(h, i, true, BRAND)),
      }),
      ...rows.map(
        (r, ri) =>
          new TableRow({
            children: r.map((c, i) =>
              cell(c, i, false, ri % 2 ? "F7FAFD" : undefined),
            ),
          }),
      ),
    ],
  });
}

/* ---------- 内容 ---------- */

const children = [];

/* 封面 */
children.push(
  new Paragraph({ spacing: { before: 2600, after: 0 }, children: [] }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text: "CRM 客户管理系统", size: 64, bold: true, color: INK })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text: "产品功能说明书", size: 36, bold: true, color: BRAND })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 700 },
    children: [
      new TextRun({ text: "客户全周期管理，让销售更高效", size: 24, color: MUTED }),
    ],
  }),
);

children.push(
  infoTable(
    [
      ["文档版本", "V1.0"],
      ["文档日期", "2026 年 8 月 26 日"],
      ["产品版本", "企业版"],
      ["覆盖范围", "线索管理、客户管理、联系人、跟进管理、商机管理、数据看板、系统设置"],
      ["文档用途", "产品功能演示与交付说明"],
    ],
    2400,
  ),
);

children.push(new Paragraph({ children: [new PageBreak()] }));

/* 目录。页码对应当前正文排版，正文有增删时需同步调整 */
const TOC = [
  ["一、产品概述", 3],
  ["1.1　核心价值", 3, 1],
  ["1.2　功能地图", 4, 1],
  ["二、系统登录", 5],
  ["2.1　账号与角色", 5, 1],
  ["三、数据首页", 6],
  ["3.1　页面构成", 6, 1],
  ["四、线索管理", 7],
  ["4.1　主要功能", 7, 1],
  ["五、客户管理", 8],
  ["5.1　客户列表", 8, 1],
  ["5.2　客户详情与跟进记录", 9, 1],
  ["5.3　页面功能明细", 10, 1],
  ["六、联系人", 11],
  ["七、商机管理", 12],
  ["7.1　商机列表", 12, 1],
  ["7.2　商机管道", 13, 1],
  ["八、跟进管理", 14],
  ["8.1　跟进记录", 14, 1],
  ["8.2　跟进计划", 15, 1],
  ["九、系统设置", 16],
  ["9.1　团队成员", 16, 1],
  ["9.2　账号安全", 16, 1],
  ["十、后续规划", 17],
  // 页码与当前 16 页排版一致，正文增删后需重新核对
];

children.push(
  H1("目录"),
  new Paragraph({ spacing: { after: 120 }, children: [] }),
  ...TOC.map(([t, p, sub]) => tocLine(t, p, sub)),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 一、产品概述 */
children.push(
  H1("一、产品概述"),
  P(
    "本系统是一套面向销售团队的客户关系管理平台，围绕「线索 → 客户 → 联系人 → 跟进 → 商机」这条主线构建完整闭环，帮助企业把分散在个人手中的客户信息沉淀为组织资产，把销售过程从依赖个人经验转变为标准化、可度量的流程。",
  ),
  P(
    "系统已完成上述核心主线的全部功能，所有页面均可进行真实的数据录入、查询与流转，非演示原型。",
  ),
  H2("1.1 核心价值"),
  BULLET(
    "全渠道线索统一汇聚，一键转为客户并自动带出联系人，转化路径完整可追溯。",
    "线索不流失",
  ),
  BULLET(
    "每一次电话、会议、拜访、邮件都留痕，形成客户跟进时间线，人员交接不断档。",
    "过程可追溯",
  ),
  BULLET(
    "商机按五个标准阶段推进，阶段变更自动同步成交概率，管道状态一目了然。",
    "推进标准化",
  ),
  BULLET(
    "预测销售额按「商机金额 × 成交概率」加权计算，比简单求和更贴近真实业绩预期。",
    "预测更准确",
  ),
  BULLET(
    "按角色区分操作权限，成员停用时强制转交名下客户与商机，避免数据成为孤儿。",
    "数据可管控",
  ),
  // 单独起页，否则 11 行的表格会被拆到下一页只剩一行
  new Paragraph({ children: [new PageBreak()] }),
  H2("1.2 功能地图"),
  P("系统共分为七大功能板块，当前状态如下："),
  gridTable(
    ["功能板块", "主要页面", "当前状态"],
    [
      ["数据首页", "经营看板", "已交付"],
      ["线索管理", "线索列表、线索转客户", "已交付"],
      ["客户管理", "客户列表、客户详情", "已交付"],
      ["联系人", "联系人总表", "已交付"],
      ["商机管理", "商机列表、商机管道", "已交付"],
      ["跟进管理", "跟进记录、跟进计划", "已交付"],
      ["系统设置", "团队成员、修改密码", "已交付"],
      ["合同管理", "—", "规划中"],
      ["产品管理", "—", "规划中"],
      ["报表分析", "—", "规划中"],
      ["目标管理", "—", "规划中"],
    ],
    [2400, 4746, 2600],
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 二、登录 */
children.push(
  H1("二、系统登录"),
  P(
    "系统采用邮箱与密码登录。密码经加密存储，登录凭证有效期为 7 天。未登录状态下访问任意功能页面，将自动引导至登录页。",
  ),
  ...figure("01-login", "图 2-1　系统登录页", 420),
  H2("2.1 账号与角色"),
  P("系统内置三种角色，权限范围如下："),
  gridTable(
    ["角色", "权限范围"],
    [
      ["系统管理员", "全部功能，并可新增、编辑、停用团队成员"],
      ["销售主管", "全部业务功能，可查看团队成员构成，不可增减成员"],
      ["销售", "全部业务功能，可查看团队成员构成，不可增减成员"],
    ],
    [2600, 7146],
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 三、数据首页 */
children.push(
  H1("三、数据首页"),
  P(
    "数据首页是团队每日的经营视图，将线索储备、客户活跃度、商机管道与待办事项集中呈现，管理者一屏即可掌握整体进展。",
  ),
  ...figure("02-dashboard", "图 3-1　数据首页"),
  H2("3.1 页面构成"),
  BULLET(
    "线索总数、活跃客户数、本月新增商机、预测销售额，每项均附带与上月的环比变化。其中预测销售额按「进行中商机金额 × 成交概率」加权计算。",
    "关键指标卡",
  ),
  BULLET(
    "双曲线呈现累计客户数与近 30 天活跃客户数的变化，支持近 7 天、近 30 天、近 90 天三个时间窗口切换。",
    "客户趋势分析",
  ),
  BULLET("按已成交金额对销售人员排名，前三名以名次徽标突出显示。", "销售团队业绩排行"),
  BULLET(
    "五个阶段的商机数量与金额分布，仅统计进行中的商机，已赢单与已丢单不计入，确保管道反映真实的在途业务。",
    "商机管道漏斗",
  ),
  BULLET(
    "汇总全员未完成任务中截止时间最近的若干条，可直接跳转至对应客户。",
    "近期跟进任务",
  ),
  BULLET("本月新增客户数、商机赢单率、进行中商机总金额，均配趋势缩略图。", "辅助指标"),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 四、线索管理 */
children.push(
  H1("四、线索管理"),
  P(
    "线索是客户的上游来源。官网留资、电话咨询、展会获取、转介绍、广告投放等各渠道的原始信息统一汇入线索池，经初步甄别后转为正式客户。",
  ),
  ...figure("03-leads", "图 4-1　线索管理"),
  H2("4.1 主要功能"),
  BULLET("记录线索名称、联系人、电话、邮箱、所属行业、来源渠道与负责人。", "线索录入"),
  BULLET("待跟进、跟进中、已转化、已放弃四种状态，支持按状态筛选与关键词检索。", "状态管理"),
  BULLET(
    "一键将线索转为正式客户。系统会自动创建客户档案并带入行业、来源、联系方式等信息，同时将线索联系人建为该客户的关键联系人，随后标记线索为「已转化」并建立双向关联，最后跳转至新客户详情页。已转化的线索不可重复转换，列表中直接提供客户档案入口。",
    "线索转客户",
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 五、客户管理 */
children.push(
  H1("五、客户管理"),
  P(
    "客户管理是系统使用频率最高的模块，承载客户档案的集中维护、多维检索与批量运营。",
  ),
  H2("5.1 客户列表"),
  ...figure("04-customers", "图 5-1　客户列表"),
  P("列表展示客户名称、所属行业、主要联系人、跟进状态、最近跟进时间、负责人与成交概率，重点客户以星标标注。"),
  BULLET(
    "按所属行业、跟进状态、负责人三个维度组合筛选，并支持按客户名称或联系人姓名进行关键词检索。",
    "多维筛选",
  ),
  BULLET(
    "勾选多条记录后，可批量变更负责人、批量调整跟进状态或批量删除，适用于人员调岗、区域重划等场景。",
    "批量操作",
  ),
  BULLET("可将当前列表导出为 CSV 文件，便于线下汇报或二次统计。", "数据导出"),
  BULLET(
    "记录客户等级、来源、阶段、预计成交日、成交概率、标签及联系方式等完整档案信息；选择客户阶段时自动带出对应的默认成交概率。",
    "客户建档",
  ),
  new Paragraph({ children: [new PageBreak()] }),
  H2("5.2 客户详情与跟进记录"),
  P(
    "客户详情页是「跟踪客户」的核心界面。页面顶部集中展示客户的关键商务信息，左侧为跟进动态时间线，右侧为待办事项与沟通统计，销售人员在此即可完成对单一客户的全部日常操作。",
  ),
  ...figure("05-customer-detail", "图 5-2　客户详情 · 跟进记录"),
  P(
    "跟进动态的八种类型为：电话沟通、线上会议、上门拜访、邮件沟通、短信沟通、跟进任务、跟进提醒、其他记录。电话与会议记录显示通话时长，任务与提醒显示截止时间，会议显示参与人，邮件可附带附件。新增或删除记录时，客户的「最近跟进」时间自动同步更新。",
  ),
  new Paragraph({ children: [new PageBreak()] }),
  H2("5.3 页面功能明细"),
  P("页面左侧为五个功能页签，右侧为四个常驻信息卡，各自作用如下："),
  gridTable(
    ["区域", "名称", "说明"],
    [
      [
        "左侧页签",
        "跟进动态",
        "按时间倒序呈现全部沟通记录，共八种类型，可按类型筛选",
      ],
      ["", "商机", "该客户名下全部商机，含金额、阶段、成交概率与赢单状态"],
      ["", "待办任务", "与该客户相关的待办事项，可直接勾选完成"],
      ["", "联系人", "该客户的联系人名录，可标记关键联系人，支持新增、编辑与删除"],
      ["", "客户资料", "完整档案信息，包含行业、等级、来源、官网、地址、标签与备注"],
      [
        "右侧信息卡",
        "待办任务",
        "展示未完成事项及其截止时间，逾期项以红色标注，可就地勾选完成",
      ],
      ["", "下次跟进计划", "记录下次跟进的主题、时间、方式与负责人，确保客户推进不中断"],
      ["", "沟通统计", "汇总跟进次数、累计通话时长、会议与邮件次数，量化沟通投入"],
      ["", "关键联系人", "以头像列表展示客户方关键决策人，支持快速添加"],
    ],
    [1500, 1700, 6546],
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 六、联系人 */
children.push(
  H1("六、联系人"),
  P(
    "联系人模块提供跨客户的人员总表，用于快速定位某位对接人及其所属客户，沉淀客户方的决策链信息。",
  ),
  ...figure("06-contacts", "图 6-1　联系人总表"),
  P(
    "支持按姓名、电话或所属客户进行检索，列表展示姓名与职务、所属客户、所属行业、手机、邮箱、微信及客户负责人，关键联系人单独标注。该页面为检索视图，联系人的新增与修改在对应客户的详情页中完成。",
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 七、商机管理 */
children.push(
  H1("七、商机管理"),
  P(
    "商机管理将销售过程拆解为五个标准阶段——初步沟通、需求确认、方案报价、谈判审核、赢单成交，并提供列表与看板两种视图，分别适用于精细管理与全局把控。",
  ),
  H2("7.1 商机列表"),
  ...figure("07-opportunities", "图 7-1　商机列表"),
  BULLET(
    "顶部呈现商机总金额、进行中金额与加权预测金额三项汇总指标。",
    "金额汇总",
  ),
  BULLET(
    "表格内可直接下拉切换商机阶段，切换后成交概率随之自动调整，无需进入编辑页。",
    "阶段行内推进",
  ),
  BULLET("每条商机提供赢单与丢单快捷操作，结果即时反映至首页漏斗与业绩排行。", "结果标记"),
  BULLET("支持按阶段、状态、负责人及关键词组合筛选，金额列可排序。", "筛选与排序"),
  new Paragraph({ children: [new PageBreak()] }),
  H2("7.2 商机管道"),
  ...figure("08-pipeline", "图 7-2　商机管道看板"),
  P(
    "看板以五列呈现各阶段的在途商机，每列顶部标注该阶段的商机数量与金额合计。卡片支持直接拖拽至其他阶段，落下后即时保存并自动调整成交概率，销售例会上可实时更新推进状态。看板仅显示进行中的商机，已关闭商机不干扰视图。",
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 八、跟进管理 */
children.push(
  H1("八、跟进管理"),
  H2("8.1 跟进记录"),
  P(
    "跟进记录提供跨客户的全局沟通流水，管理者可据此了解团队的实际动作与工作强度。",
  ),
  ...figure("09-follow-ups", "图 8-1　跟进记录"),
  P(
    "支持按跟进类型、跟进人及关键词（可匹配标题、内容或客户名称）进行检索，列表展示类型、跟进内容摘要、所属客户、对接人、时长、状态、跟进人与时间。",
  ),
  new Paragraph({ children: [new PageBreak()] }),
  H2("8.2 跟进计划"),
  P("跟进计划页面将待办任务与跟进计划并列呈现，是销售人员每日开工的第一入口。"),
  ...figure("10-plans", "图 8-2　跟进计划"),
  BULLET("可在「我的」与「全部成员」之间切换，管理者据此掌握团队待办负荷。", "视角切换"),
  BULLET(
    "提供全部、逾期、今天、本周四档筛选，逾期事项以红色标签突出提示。",
    "时间筛选",
  ),
  BULLET(
    "任务可直接勾选完成，计划可标记为已执行；顶部通知铃铛的角标即为本人未完成任务数。",
    "即时处理",
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 九、系统设置 */
children.push(
  H1("九、系统设置"),
  P("系统设置用于团队成员管理与账号安全维护。"),
  ...figure("11-settings", "图 9-1　设置管理 · 团队成员"),
  H2("9.1 团队成员"),
  P(
    "成员列表展示每位成员的职位、角色及其负责的客户数、商机数与跟进数，团队分工与工作量分布一目了然。",
  ),
  BULLET(
    "仅系统管理员可新增成员、编辑成员信息或调整角色；其他角色进入该页面仅可查看团队构成。",
    "权限控制",
  ),
  BULLET(
    "停用成员时，系统强制要求指定接手人，将其名下的客户、商机、待办任务与跟进计划一次性转交，杜绝数据失管。管理员不可停用本人账号，已停用成员可随时恢复。",
    "成员停用与数据转交",
  ),
  H2("9.2 账号安全"),
  P(
    "所有角色均可自助修改本人密码，修改时需校验原密码并二次确认新密码。密码采用加密方式存储，系统不保存明文。",
  ),
  new Paragraph({ children: [new PageBreak()] }),
);

/* 十、后续规划 */
children.push(
  H1("十、后续规划"),
  P(
    "以下模块已在系统中预留导航入口，将在后续版本中依次交付。各模块的数据结构已在现有模型中预留衔接点，无需重构即可接入。",
  ),
  gridTable(
    ["模块", "规划内容"],
    [
      [
        "合同管理",
        "商机赢单后生成合同，管理合同条款、金额、签署状态与回款计划，与商机数据打通",
      ],
      ["产品管理", "维护产品目录与标准价格体系，商机与合同可直接引用产品明细"],
      [
        "报表分析",
        "销售漏斗转化率、人员业绩对比、客户来源分析、周期性经营报表与自定义导出",
      ],
      ["目标管理", "按人员与团队设定周期业绩目标，实时对比完成进度并预警"],
    ],
    [2200, 7546],
  ),
  RULE_P(),
  P(
    "本文档所有截图均取自系统实际运行界面，数据为演示数据。如需针对贵司业务流程进行功能调整或字段定制，欢迎进一步沟通。",
    { color: MUTED, size: 19 },
  ),
);

/* ---------- 组装 ---------- */

const doc = new Document({
  creator: "CRM 产品团队",
  title: "CRM 客户管理系统 · 产品功能说明书",
  description: "CRM 客户管理系统产品功能说明书 V1.0",
  numbering: {
    config: [
      {
        reference: "dot",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360, hanging: 200 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: {
      document: {
        run: { font: "Microsoft YaHei", size: 21, color: "2B3A4F" },
        paragraph: { spacing: { line: 300 } },
      },
    },
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: "Microsoft YaHei", size: 32, bold: true, color: INK },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: "Microsoft YaHei", size: 25, bold: true, color: INK },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: 16838 }, // A4
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  children: ["CRM 客户管理系统 · 产品功能说明书　|　第 ", PageNumber.CURRENT, " 页"],
                  size: 16,
                  color: MUTED,
                }),
              ],
            }),
          ],
        }),
      },
      children,
    },
  ],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(OUT, buf);
console.log("已生成：", OUT, `(${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
