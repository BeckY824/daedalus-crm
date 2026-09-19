"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Row,
  Col,
  App,
  Tabs,
  Alert,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { SettingOutlined, PlusOutlined, EditOutlined, StopOutlined, UndoOutlined } from "@ant-design/icons";
import { PageHead, UserCell } from "@/components/ui";
import { dayjs } from "@/lib/utils";
import { ROLES } from "@/lib/constants";
import type { SessionUser } from "@/lib/auth";
import { saveUser, deactivateUser, reactivateUser, changeMyPassword, 退出这台机器, type 机器 } from "./actions";
import AiSettingsTab, { type LlmView } from "./AiSettingsTab";
import BusinessSettingsTab from "./BusinessSettingsTab";
import DesktopTab, { type 桌面端信息 } from "./DesktopTab";
import ImportsTab from "./ImportsTab";
import ProfileTab from "./ProfileTab";
import KeymapTab from "./KeymapTab";
import type { BusinessConfig } from "@/lib/business-config";
import { useBusiness } from "@/lib/business-client";
import type { AiUsage } from "@/lib/ai-usage";

type Row = {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  active: boolean;
  customerCount: number;
  oppCount: number;
  followCount: number;
};

export type AuditRow = {
  id: string;
  at: string;
  userName: string;
  action: string;
  entity: string;
  summary: string;
  detail: string | null;
};

/** 动作与对象的中文叫法，日志里直接显示英文没人看得懂 */
const ACTION_LABEL: Record<string, string> = {
  create: "新建", update: "修改", delete: "删除", assign: "转派",
  convert: "转化", deactivate: "停用", reactivate: "恢复", password: "改密码", device_revoke: "退出机器", ai_use: "AI", ai_apply: "确认 AI 建议",
};
const ENTITY_LABEL: Record<string, string> = {
  Customer: "学员", Contract: "签约", Lead: "线索", User: "成员", Channel: "渠道", Setting: "系统设置", Ai: "AI 功能", Device: "机器",
};
/** 明细是入库时序列化的 JSON，格式化给人看；万一存了非法内容也不能让页面崩 */
function safeJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const ACTION_COLOR: Record<string, string> = {
  create: "success", update: "processing", delete: "error",
  assign: "cyan", convert: "gold", deactivate: "warning", reactivate: "default", password: "default", ai_use: "purple", ai_apply: "green",
};

/** 左目录里每一项底下那句话。放在组件外面，免得每次渲染重建 */
const 说明表: Record<string, string> = {
  profile: "你的名字、职位",
  keymap: "键盘上那几个键",
  members: "谁能进、谁是管理员",
  password: "改密码、看哪几台机器登录着",
  desktop: "账号、备份、更新",
  ai: "走哪把 Key、还剩几次",
  business: "客户 / 学员 这些叫法",
  imports: "导进来的那几批，可撤销",
  audit: "每一次改动的记录",
};

export default function SettingsView({
  users,
  me,
  isAdmin,
  logs,
  llm,
  business,
  aiUsage,
  机器,
  桌面端 = null,
  用邮箱登录 = false,
}: {
  users: Row[];
  me: SessionUser;
  isAdmin: boolean;
  logs: AuditRow[];
  llm: LlmView;
  business: BusinessConfig;
  aiUsage: AiUsage;
  /**
   * 用这个云端账号登录着的桌面端机器。**null 表示这一栏不适用**（自部署版、共享工作区），
   * 空数组表示一台都没有。见 actions.ts 的 我的控制面账号。
   */
  机器: 机器[] | null;
  /**
   * 桌面端本地模式：多一栏「桌面端」（账号、备份、更新），同时**不摆「登录与密码」**——
   * 那一栏改的是本机业务账号的密码，而桌面端只有云端账号这一套身份（2026-09-17 起），
   * 本机那把密码用户永远用不到，摆着只会再造出两把密码对不上的局面。null 表示不是桌面端。
   */
  桌面端?: 桌面端信息 | null;
  /** 托管版：成员的登录标识是邮箱，不是用户名。见这一页表单里那段注释 */
  用邮箱登录?: boolean;
}) {
  const router = useRouter();
  const [搜, set搜] = useState("");
  // 当前页签由地址栏 ?tab= 决定：中栏那列设置项就是一组带 tab 的链接，刷新、回退都对得上
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") ?? "members";
  const b = useBusiness();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();
  const [pwdForm] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) form.setFieldsValue({ ...editing, password: "" });
    else {
      form.resetFields();
      form.setFieldsValue({ role: "SALES", title: "销售", active: true });
    }
  }, [open, editing, form]);

  async function onOk() {
    const v = await form.validateFields();
    const 提交 = (force?: boolean) => saveUser({ id: editing?.id, ...v, force });

    const res = await 提交();
    if (res.ok) {
      message.success(editing ? "已保存" : "成员已创建");
      setOpen(false);
      router.refresh();
      return;
    }
    if ("error" in res) {
      message.error(res.error);
      return;
    }

    /**
     * 同名不硬拦：同名同事是正常情况，拦下来管理员就建不了人。
     * 但要让他知道系统里已经有一个，避免把「张三」错建成第二条而不自知。
     */
    const 同名 = res.duplicateName;
    modal.confirm({
      title: "已有同名成员",
      content: (
        <>
          <div>
            系统里已有一位<b>{同名.name}</b>
            {同名.title ? `（${同名.title}）` : ""}，{用邮箱登录 ? "登录邮箱" : "登录用户名"} <b>{同名.email}</b>。
          </div>
          <div style={{ marginTop: 8 }}>
            如果这是另一个人，可以继续创建，各处负责人下拉会自动带上登录名区分；
            如果是同一个人，请点取消。
          </div>
        </>
      ),
      okText: "确实是另一个人，继续创建",
      cancelText: "取消",
      async onOk() {
        const again = await 提交(true);
        if (again.ok) {
          message.success(editing ? "已保存" : "成员已创建");
          setOpen(false);
          router.refresh();
        } else if ("error" in again) {
          message.error(again.error);
        }
      },
    });
  }

  /**
   * 退出一台机器。
   *
   * 问一句再退：这动作对那台机器是不可逆的（令牌吊了就是吊了，要人拿密码重登），
   * 而按钮就摆在表格行里，误点的成本比翻一次确认框高。
   */
  function onRevoke(m: 机器) {
    modal.confirm({
      title: `退出「${m.名字}」？`,
      content: (
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
          那台机器上的 CRM 会回到登录界面，AI 立刻停。<b>本地数据都在那台机器上，不受影响</b>，
          拿账号密码重新登录就能接着用。
        </Typography.Paragraph>
      ),
      okText: "退出这台",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const res = await 退出这台机器(m.id);
        if (res.ok) {
          message.success("已退出");
          router.refresh();
        } else message.error(res.error);
      },
    });
  }

  function onDeactivate(r: Row) {
    const others = users.filter((u) => u.active && u.id !== r.id);
    if (!others.length) {
      message.error("没有可接手的成员");
      return;
    }
    let target = others[0].id;
    modal.confirm({
      title: `停用成员「${r.name}」`,
      content: (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            该成员名下有 {r.customerCount} 个客户、{r.oppCount} 个商机，停用前需转交给：
          </Typography.Paragraph>
          <Select
            defaultValue={target}
            style={{ width: "100%" }}
            onChange={(v) => (target = v)}
            options={others.map((u) => ({ value: u.id, label: `${u.name}（${u.title}）` }))}
          />
        </div>
      ),
      okText: "确认停用",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const res = await deactivateUser(r.id, target);
        if (res.ok) {
          message.success("已停用并转交");
          router.refresh();
        } else message.error(res.error);
      },
    });
  }

  const columns: ColumnsType<Row> = [
    { title: "姓名", dataIndex: "name", width: 150, render: (v) => <UserCell name={v} size={30} /> },
    { title: 用邮箱登录 ? "登录邮箱" : "登录用户名", dataIndex: "email", width: 200 },
    { title: "职位", dataIndex: "title", width: 120 },
    {
      title: "角色",
      dataIndex: "role",
      width: 120,
      render: (v) => (
        <Tag color={v === "ADMIN" ? "red" : v === "MANAGER" ? "blue" : "default"} style={{ margin: 0, borderRadius: 6 }}>
          {ROLES.find((r) => r.value === v)?.label ?? v}
        </Tag>
      ),
    },
    { title: "负责客户", dataIndex: "customerCount", width: 90 },
    { title: "商机数", dataIndex: "oppCount", width: 80 },
    { title: "跟进数", dataIndex: "followCount", width: 80 },
    {
      title: "状态",
      dataIndex: "active",
      width: 84,
      render: (v) => (
        <Tag color={v ? "success" : "default"} style={{ margin: 0, borderRadius: 6 }}>
          {v ? "在职" : "已停用"}
        </Tag>
      ),
    },
    {
      title: "",
      key: "act",
      width: 120,
      render: (_, r) =>
        isAdmin ? (
          <Space size={2}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditing(r);
                setOpen(true);
              }}
            />
            {r.active ? (
              <Button
                type="text"
                size="small"
                danger
                icon={<StopOutlined />}
                disabled={r.id === me.id}
                onClick={() => onDeactivate(r)}
              />
            ) : (
              <Button
                type="text"
                size="small"
                icon={<UndoOutlined />}
                onClick={async () => {
                  await reactivateUser(r.id);
                  message.success("已恢复");
                  router.refresh();
                }}
              />
            )}
          </Space>
        ) : null,
    },
  ];

  /** 设置的几项。说明一句话写清这一项管什么——只有名字的话，「业务配置」是个谜 */
  const 目录: { key: string; label: string; 说明: string; children: React.ReactNode }[] = [
    {
      /**
       * 个人资料排第一：这一页最常被打开的原因是「改我自己的什么」，
       * 而不是「管别人」。改名以前只在「团队成员」那个只有管理员打得开的弹窗里，
       * 于是销售想改自己的名字得去求管理员。
       */
      key: "profile",
      label: "个人资料",
      children: <ProfileTab me={{ name: me.name, title: me.title, email: me.email }} />,
    },
    {
      key: "members",
      label: "团队成员",
      children: (
          <>
            {!isAdmin && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 14 }}
                title="只有系统管理员可以新增或停用成员，你可以在此查看团队构成。"
              />
            )}
            {isAdmin && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                style={{ marginBottom: 14 }}
                onClick={() => {
                  setEditing(null);
                  setOpen(true);
                }}
              >
                新增成员
              </Button>
            )}
            <Table<Row>
              rowKey="id"
              size="middle"
              dataSource={users}
              columns={columns}
              pagination={false}
              scroll={{ x: 1050 }}
            />
          </>
        ),
      },
    {
      key: "keymap",
      label: "快捷键",
      children: <KeymapTab 桌面端={Boolean(桌面端)} />,
    },
    {
      key: "password",
      label: "登录与密码",
      children: (
        <div style={{ paddingTop: 8 }}>
          {/*
            改密码的代价要写在按钮旁边，不是等人发现。它会把这个账号的桌面端
            全部踢下线（见 lib/tenant/members.ts 的 改密码），而「我只是换个密码」
            的人不会预期到手上那几台机器都要重登——尤其是他并不想动的那几台。
          */}
          {机器 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16, maxWidth: 560 }}
              title="改完密码，所有地方都要重新登录"
              description="网页端其他设备上的登录状态会作废，桌面端每一台已登录的机器也会退出（那些机器上的数据不受影响）。只想退出其中一台的话，用下面的「已登录的机器」，别动密码。"
            />
          )}
          <Form
            form={pwdForm}
            layout="vertical"
            style={{ maxWidth: 380 }}
            onFinish={async (v) => {
              const res = await changeMyPassword(v.oldPwd, v.newPwd);
              if (res.ok) {
                message.success("密码已更新");
                pwdForm.resetFields();
              } else message.error(res.error);
            }}
          >
            <Form.Item name="oldPwd" label="原密码" rules={[{ required: true, message: "请输入原密码" }]}>
              <Input.Password />
            </Form.Item>
            <Form.Item
              name="newPwd"
              label="新密码"
              rules={[
                { required: true, message: "请输入新密码" },
                { min: 8, message: "至少 8 位" },
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="确认新密码"
              dependencies={["newPwd"]}
              rules={[
                { required: true, message: "请再次输入新密码" },
                ({ getFieldValue }) => ({
                  validator: (_, v) =>
                    !v || getFieldValue("newPwd") === v
                      ? Promise.resolve()
                      : Promise.reject(new Error("两次输入不一致")),
                }),
              ]}
            >
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              保存
            </Button>
          </Form>
          {机器 && (
            <div style={{ marginTop: 32, maxWidth: 620 }}>
              <Typography.Title level={5} style={{ marginBottom: 4 }}>
                已登录的机器
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                用这个云端账号登录过桌面端的机器。丢了一台就在这里把它退出来——
                不用为此改密码，另外几台照常用着。
              </Typography.Paragraph>
              <Table<机器>
                rowKey="id"
                size="small"
                dataSource={机器}
                pagination={false}
                locale={{ emptyText: "还没有机器用这个账号登录过桌面端" }}
                columns={[
                  { title: "机器", dataIndex: "名字", render: (v: string) => <b>{v}</b> },
                  {
                    title: "登录于",
                    dataIndex: "登录于",
                    width: 150,
                    render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
                  },
                  {
                    title: "最近调用 AI",
                    dataIndex: "最近使用",
                    width: 150,
                    /* 只有走模型网关时才记，而且五分钟内只记一次（device-token.ts），
                       所以「还没有」是常态：登录了但一次 AI 都没用过。别说成「从未使用」 */
                    render: (v: string | null) =>
                      v ? dayjs(v).format("YYYY-MM-DD HH:mm") : <span style={{ color: "var(--ink-soft)" }}>还没有</span>,
                  },
                  {
                    title: "",
                    width: 88,
                    render: (_: unknown, r: 机器) => (
                      <Button size="small" danger type="text" onClick={() => onRevoke(r)}>
                        退出
                      </Button>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>
        ),
      },
      ...(桌面端 ? [{ key: "desktop", label: "桌面端", children: <DesktopTab 信息={桌面端} /> }] : []),
      ...(isAdmin
        ? [
            { key: "ai", label: "AI 接入", children: <AiSettingsTab llm={llm} usage={aiUsage} /> },
            { key: "business", label: "业务配置", children: <BusinessSettingsTab value={business} /> },
          ]
        : []),
    { key: "imports", label: "导入记录", children: <ImportsTab /> },
    {
      key: "audit",
      label: "操作日志",
      children: (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 14 }}
              title={`所有人都能查看和修改全部${b.customer}数据，因此每一次改动都会记录在这里`}
              description="记录只增不改不删，成员被停用或删除后其历史操作仍然保留。此处显示最近 200 条。"
            />
            <Table<AuditRow>
              rowKey="id"
              size="middle"
              dataSource={logs}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              locale={{ emptyText: "还没有任何操作记录" }}
              expandable={{
                // 明细是 JSON，平时折起来，要追细节时再展开
                rowExpandable: (r) => !!r.detail,
                expandedRowRender: (r) => (
                  <pre
                    style={{
                      margin: 0,
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      color: "var(--ink-soft)",
                    }}
                  >
                    {safeJson(r.detail)}
                  </pre>
                ),
              }}
              columns={[
    {
                  title: "时间",
                  dataIndex: "at",
                  width: 170,
                  render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
                },
    {
                  title: "操作人",
                  dataIndex: "userName",
                  width: 130,
                  render: (v: string) => <UserCell name={v} size={26} />,
                },
    {
                  title: "动作",
                  dataIndex: "action",
                  width: 100,
                  render: (v: string) => (
                    <Tag color={ACTION_COLOR[v] ?? "default"} style={{ margin: 0, borderRadius: 6 }}>
                      {ACTION_LABEL[v] ?? v}
                    </Tag>
                  ),
                },
    {
                  title: "对象",
                  dataIndex: "entity",
                  width: 90,
                  render: (v: string) => (v === "Customer" ? b.customer : ENTITY_LABEL[v] ?? v),
                },
                { title: "内容", dataIndex: "summary" },
              ]}
            />
          </>
        ),
      },
  ]
    /**
     * 桌面端是**一个人用的**：数据在他自己机器上，登录的是他自己的云端账号，
     * 「团队成员」那一栏只会列出他一个人，还摆着「新增成员」——那是个会骗人的入口：
     * 在本机库里加出来的人没有云端账号，登不进任何地方（2026-09-18 用户指出）。
     * 要多人一起用，是「连接服务器」那条路，不是在这台机器上加账号。
     *
     * 「登录与密码」不摆的理由同源：桌面端只有云端账号这一套身份，本机那把密码用不到。
     */
    .filter((x) => !(桌面端 && (x.key === "password" || x.key === "members")))
    .map((x) => ({ ...x, 说明: 说明表[x.key] ?? "" })) as { key: string; label: string; 说明: string; children: React.ReactNode }[];

  /**
   * 分组：**「我自己的」和「整个团队的」分开**——这两件事的心理位置不一样。
   * 顺序就是这里的顺序，不跟着上面那个数组走（那个数组是按谁先写的排的）。
   * 没列进来的 key 会落到最后一组，加了新栏忘了分组也不会凭空消失。
   */
  const 分组表: [string, string[]][] = [
    ["个人", ["profile", "password", "keymap"]],
    ["工作区", ["members", "business", "ai", "imports", "audit"]],
    ["应用", ["desktop"]],
  ];

  const 词 = 搜.trim().toLowerCase();
  const 搜到的 = 词 ? 目录.filter((x) => `${x.label}${x.说明}${x.key}`.toLowerCase().includes(词)) : 目录;
  const 分好组: [string, typeof 目录][] = 词
    ? [["", 搜到的]]
    : 分组表
        .map(([名, keys]) => [名, keys.map((k) => 搜到的.find((x) => x.key === k)).filter(Boolean)] as [string, typeof 目录])
        .concat([["其它", 搜到的.filter((x) => !分组表.some(([, ks]) => ks.includes(x.key)))]])
        .filter(([, 项]) => 项.length > 0);

  return (
    <>
      <PageHead title="设置" subtitle="成员、AI 与业务配置" />

      {/*
        左目录，不是顶上一排页签。有两项只有管理员看得到，页签横着排时
        管理员和普通成员看到的宽度都不一样；竖着排还能给每项留一句说明。
        角色仍然是 tablist / tab / tabpanel——读屏按这个认，e2e 也按这个找。
        窄屏下目录仍然是单列，只是压到正文上面（见 globals.css 的 .set）。

        **分组和搜索是 2026-09-17 加的**（对着 Claude / Codex 桌面端那两个设置窗口）：
        项数到了八个，一列平铺就开始要一项项扫。分组把「我自己的」和「整个团队的」分开——
        这两件事的心理位置完全不同。搜索框在项数少时是多余的，但它救的是
        「我知道那个开关叫什么、但不知道它在哪一栏」，而那正是设置页最常见的一次来访。
      */}
      <div className="set">
        <div className="set-nav" role="tablist" aria-orientation="vertical" aria-label="设置分类">
          <input
            className="set-search"
            type="search"
            value={搜}
            onChange={(e) => set搜(e.target.value)}
            placeholder="搜设置…"
            aria-label="搜索设置"
          />
          {搜到的.length === 0 && <div className="set-nav-empty">没有匹配的设置项</div>}
          {分好组.map(([组名, 项]) => (
            <div key={组名} className="set-nav-g">
              {/* 搜索时不摆组标题：那时人要的是一份短名单，不是结构 */}
              {!搜.trim() && <div className="set-nav-h">{组名}</div>}
              {项.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              id={`set-tab-${x.key}`}
              aria-selected={tab === x.key}
              aria-controls={`set-panel-${x.key}`}
              className={`set-nav-i${tab === x.key ? " on" : ""}`}
              /*
                用原生 history 而不是 router.replace：这一页是 force-dynamic 的服务端组件，
                router.replace 改个 ?tab= 会让 Next 把整页重新向服务端要一遍——200 条操作日志、
                成员、AI 配置，桌面端还要去云端问一次余额。切个页签卡半秒，就是这么来的
                （2026-09-17 用户在真机上感觉到「偶尔卡卡的」）。Next 会把原生 pushState/replaceState
                同步进 useSearchParams，所以下面读 tab 的那行照旧生效，刷新、回退也照旧对得上。
              */
              onClick={() => window.history.replaceState(null, "", `${pathname}?tab=${x.key}`)}
            >
              <b>{x.label}</b>
              <span>{x.说明}</span>
            </button>
              ))}
            </div>
          ))}
        </div>
        <div className="set-body" role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`}>
          {目录.find((x) => x.key === tab)?.children ?? 目录[0].children}
        </div>
      </div>

      <Modal
        open={open}
        title={editing ? `编辑成员 · ${editing.name}` : "新增成员"}
        onCancel={() => setOpen(false)}
        onOk={onOk}
        okText="保存"
        cancelText="取消"
        width={560}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请填写姓名" }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              {/*
                两种部署，这一栏的含义不同：

                自部署版存的是**登录用户名**，不是邮箱——登录页填的就是它，
                既有账号是 admin / zhangsan / lisi。之前挂着 email 格式校验，
                导致管理员按既有惯例建「lisi」时被前端直接挡死。

                托管版存的是**邮箱**：那边登录校验的是控制面账号，账号按邮箱认，
                而且他忘了密码要用它收验证码——填用户名的话 /forgot 那条路对他是断的。
                建好之后不能改：它同时是控制面账号的标识，改一边不改另一边就对不上。

                两种都强制小写并在输入时归一，服务端登录也会 toLowerCase，
                否则填了 LiSi 会出现「我填的名字登不进去」。
              */}
              <Form.Item
                name="email"
                label={用邮箱登录 ? "登录邮箱" : "登录用户名"}
                normalize={(v?: string) => v?.trim().toLowerCase()}
                rules={
                  用邮箱登录
                    ? [
                        { required: true, message: "请填写邮箱" },
                        { type: "email" as const, message: "这个邮箱看起来不对" },
                      ]
                    : [
                        { required: true, message: "请填写登录用户名" },
                        {
                          pattern: /^[a-z0-9._-]{2,32}$/,
                          message: "只能用小写字母、数字和 . _ -，长度 2–32 位",
                        },
                      ]
                }
                extra={
                  用邮箱登录
                    ? editing?.id
                      ? "登录邮箱建好之后不能改"
                      : "他用它登录，也用它找回密码。建好之后不能改"
                    : "登录时输入的就是它，如 lisi"
                }
              >
                <Input placeholder={用邮箱登录 ? "如：lisi@qiming.com" : "如：lisi"} disabled={Boolean(用邮箱登录 && editing?.id)} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="title" label="职位">
                <Input placeholder="销售 / 销售经理 / 销售主管" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="role" label="角色">
                <Select options={ROLES.map((r) => ({ value: r.value, label: r.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="password"
                label={editing ? "重置密码（留空不改）" : "初始密码"}
                rules={editing ? [] : [{ required: true, message: "请设置初始密码" }, { min: 8, message: "至少 8 位" }]}
              >
                <Input.Password placeholder={editing ? "留空则不修改" : "至少 8 位"} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="active" label="账号状态" valuePropName="checked">
                <Switch checkedChildren="在职" unCheckedChildren="停用" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
