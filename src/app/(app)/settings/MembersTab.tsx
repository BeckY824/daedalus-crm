"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Table, Button, Space, Tag, Modal, Form, Input, Select, Switch, Row as 行, Col, App, Alert, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, StopOutlined, UndoOutlined } from "@ant-design/icons";
import { UserCell } from "@/components/ui";
import { ROLES } from "@/lib/constants";
import type { SessionUser } from "@/lib/auth";
import { saveUser, deactivateUser, reactivateUser } from "./actions";

/** 设置 · 团队成员：谁能进、谁是管理员。新增、编辑、停用（停用要先把名下的客户转交出去） */

export type Row = {
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

export default function MembersTab({
  users,
  me,
  isAdmin,
  用邮箱登录,
}: {
  users: Row[];
  me: SessionUser;
  isAdmin: boolean;
  /** 托管版：成员的登录标识是邮箱，不是用户名。见下面表单里那段注释 */
  用邮箱登录: boolean;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm();

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

  return (
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
          <行 gutter={16}>
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
          </行>
        </Form>
      </Modal>
    </>
  );
}
