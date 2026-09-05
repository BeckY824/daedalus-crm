"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { saveUser, deactivateUser, reactivateUser, changeMyPassword } from "./actions";
import AiSettingsTab, { type LlmView } from "./AiSettingsTab";
import BusinessSettingsTab from "./BusinessSettingsTab";
import type { BusinessConfig } from "@/lib/business-config";
import { useBusiness } from "@/lib/business-client";

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
  convert: "转化", deactivate: "停用", reactivate: "恢复", password: "改密码",
};
const ENTITY_LABEL: Record<string, string> = {
  Customer: "学员", Contract: "签约", Lead: "线索", User: "成员", Channel: "渠道", Setting: "系统设置",
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
  assign: "cyan", convert: "gold", deactivate: "warning", reactivate: "default", password: "default",
};

export default function SettingsView({
  users,
  me,
  isAdmin,
  logs,
  llm,
  business,
}: {
  users: Row[];
  me: SessionUser;
  isAdmin: boolean;
  logs: AuditRow[];
  llm: LlmView;
  business: BusinessConfig;
}) {
  const router = useRouter();
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
            {同名.title ? `（${同名.title}）` : ""}，登录用户名 <b>{同名.email}</b>。
          </div>
          <div style={{ marginTop: 8 }}>
            如果这是另一个人，可以继续创建，各处负责人下拉会自动带上登录用户名区分；
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
    { title: "登录用户名", dataIndex: "email", width: 200 },
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

  return (
    <>
      <PageHead
        icon={<SettingOutlined />}
        title="设置管理"
        subtitle="团队成员与账号设置"
        tag="系统设置"
        tagNote="权限清晰，数据安全可控"
      />

      <Card styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          items={[
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
              key: "password",
              label: "修改密码",
              children: (
                <Form
                  form={pwdForm}
                  layout="vertical"
                  style={{ maxWidth: 380, paddingTop: 8 }}
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
              ),
            },
            ...(isAdmin
              ? [
                  { key: "ai", label: "AI 接入", children: <AiSettingsTab llm={llm} /> },
                  { key: "business", label: "业务配置", children: <BusinessSettingsTab value={business} /> },
                ]
              : []),
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
                            color: "#475569",
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
          ]}
        />
      </Card>

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
                这个字段存的是**登录用户名**，不是邮箱：登录页填的就是它，
                既有账号是 admin / zhangsan / lisi。之前挂着 email 格式校验，
                导致管理员按既有惯例建「lisi」时被前端直接挡死。
                服务端登录时会 toLowerCase，所以这里强制小写并在输入时归一，
                否则填了 LiSi 会出现「我填的名字登不进去」。
              */}
              <Form.Item
                name="email"
                label="登录用户名"
                normalize={(v?: string) => v?.trim().toLowerCase()}
                rules={[
                  { required: true, message: "请填写登录用户名" },
                  {
                    pattern: /^[a-z0-9._-]{2,32}$/,
                    message: "只能用小写字母、数字和 . _ -，长度 2–32 位",
                  },
                ]}
                extra="登录时输入的就是它，如 lisi"
              >
                <Input placeholder="如：lisi" />
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
