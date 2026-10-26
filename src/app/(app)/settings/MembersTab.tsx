"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Table, Button, Space, Tag, Modal, Form, Input, Select, Switch, Row as 行, Col, App, Alert, Typography, Radio } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, StopOutlined, UndoOutlined } from "@ant-design/icons";
import { UserCell } from "@/components/ui";
import { ROLES } from "@/lib/constants";
import { useBusiness } from "@/lib/business-client";
import { 外贸订单 } from "@/lib/business-config";
import type { SessionUser } from "@/lib/auth";
import { saveUser, deactivateUser, reactivateUser, 停用清点, 批量停用 } from "./actions";
import type { 停用方式 } from "@/lib/offboard-db";

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
  企业版 = false,
  下属可停用 = [],
}: {
  users: Row[];
  me: SessionUser;
  isAdmin: boolean;
  /** 托管版：成员的登录标识是邮箱，不是用户名。见下面表单里那段注释 */
  用邮箱登录: boolean;
  /** 企业版才有离职交接（选放进公海、先清点）；别的版本停用对话框和原来一样 */
  企业版?: boolean;
  /** 企业版：我是他们的直属上级，能给他们办离职（D-36）。管理员不看这个，全都能办 */
  下属可停用?: string[];
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const b = useBusiness();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [恢复中, set恢复中] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    if (!open) return;
    if (editing) form.setFieldsValue({ ...editing, password: "" });
    else {
      form.resetFields();
      form.setFieldsValue({ role: "SALES", title: "销售", active: true });
    }
  }, [open, editing, form]);

  // 保存中不再收第二下：网慢、连着团队时连点几下会建出几条一样的（10-07 Sam 实测建出三条重复商机）
  const [存着, set存着] = useState(false);
  async function onOk() {
    if (存着) return;
    set存着(true);
    try {
      await 存();
    } finally {
      set存着(false);
    }
  }
  async function 存() {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
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

  const [清点中, set清点中] = useState<string | null>(null);
  const 能停 = (r: Row) => r.active && (isAdmin ? r.id !== me.id : 下属可停用.includes(r.id));
  // 企业版批量离职：勾几个人，同一个接手人、同一种方式一次办完
  const [勾了, set勾了] = useState<string[]>([]);
  const 能批量 = 企业版 && (isAdmin || 下属可停用.length > 0);
  function onBatchDeactivate() {
    const 们 = 勾了.filter((id) => users.some((u) => u.id === id && 能停(u)));
    const others = users.filter((u) => u.active && !们.includes(u.id));
    if (!们.length) return;
    if (!others.length) {
      message.error("没有可接手的成员");
      return;
    }
    let target = others[0].id;
    let 方式: 停用方式 = "转交";
    modal.confirm({
      title: `停用 ${们.length} 位成员`,
      width: 480,
      content: <BatchOffboardForm names={们.map((id) => users.find((u) => u.id === id)?.name ?? "")} others={others} defaultTarget={target} onChange={(v) => { target = v.target; 方式 = v.方式; }} />,
      okText: "确认停用",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const res = await 批量停用(们, target, 方式).catch(() => null);
        if (!res) { message.error("停用没成功，刷新再试"); return; }
        if (!res.ok) { message.error(res.error); return; }
        if (res.失败.length) {
          const 名 = (id: string) => users.find((u) => u.id === id)?.name ?? id;
          message.warning(`停用了 ${res.停了} 位；${res.失败.map((f) => `「${名(f.id)}」${f.error}`).join("；")}`);
        } else message.success(`已停用 ${res.停了} 位成员` + (res.交接中 ? "，交给接手人的部分等对方在客户页确认后才转过去" : ""));
        set勾了([]);
        router.refresh();
      },
    });
  }
  async function onDeactivate(r: Row) {
    const others = users.filter((u) => u.active && u.id !== r.id);
    if (!others.length) {
      message.error("没有可接手的成员");
      return;
    }
    if (清点中) return;
    // 企业版先数一下两种方式各会转走、放进公海多少（离职交接 D-36），对话框里照实说
    let 点: Parameters<typeof OffboardForm>[0]["点"] | null = null;
    if (企业版) {
      set清点中(r.id);
      const 清 = await 停用清点(r.id).catch(() => null);
      set清点中(null);
      if (!清?.ok) {
        message.error(清 && "error" in 清 ? 清.error : "清点没成功，刷新再试");
        return;
      }
      点 = 清;
    }
    let target = others[0].id;
    let 方式: 停用方式 = "转交";
    modal.confirm({
      title: `停用成员「${r.name}」`,
      width: 480,
      content: 点 ? (
        <OffboardForm
          name={r.name}
          点={点}
          others={others}
          defaultTarget={target}
          onChange={(v) => { target = v.target; 方式 = v.方式; }}
        />
      ) : (
        <div style={{ marginTop: 12 }}>
          {/* 说清转交的是往后要跟的活、历史业绩不动（排查 B2）。原来只写「名下 N 个客户、N 个商机」，叫法还写死成「客户」 */}
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
            {r.customerCount} 位{b.customer}，连同进行中的商机、没做完的计划和待办、线索、渠道，一起转交给：
          </Typography.Paragraph>
          <Select
            defaultValue={target}
            style={{ width: "100%" }}
            onChange={(v) => (target = v)}
            options={others.map((u) => ({ value: u.id, label: `${u.name}（${u.title}）` }))}
          />
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>
            {外贸订单(b) ? "已经下的订单、转了订单和丢单的商机" : "已经签下的业绩、赢单和丢单的商机"}，还算在「{r.name}」头上。
          </Typography.Paragraph>
        </div>
      ),
      okText: "确认停用",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        const res = await deactivateUser(r.id, target, 方式);
        if (res.ok) {
          // 企业版「交接中」：给接手人的那部分等他确认（D10）
          message.success("交接中" in res
            ? (方式 === "公海" ? "已停用，该进公海的已放进公海；其余等接手人在客户页确认后才转过去" : "已停用，名下的等接手人在客户页确认后才转过去")
            : 方式 === "公海" ? "已停用，名下的放进了公海" : "已停用并转交");
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
    { title: `负责${b.customer}`, dataIndex: "customerCount", width: 90 },
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
        !isAdmin && 能停(r) ? (
          <Button
            type="text"
            size="small"
            danger
            icon={<StopOutlined />}
            aria-label={`给 ${r.name} 办离职`}
            loading={清点中 === r.id}
            onClick={() => onDeactivate(r)}
          />
        ) : isAdmin ? (
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
                loading={清点中 === r.id}
                onClick={() => onDeactivate(r)}
              />
            ) : (
              <Button
                type="text"
                size="small"
                icon={<UndoOutlined />}
                aria-label={`恢复成员 ${r.name}`}
                loading={恢复中 === r.id}
                disabled={恢复中 !== null}
                onClick={async () => {
                  if (恢复中) return;
                  set恢复中(r.id);
                  try {
                    const result = await reactivateUser(r.id);
                    if (!result.ok) { message.error(result.error); return; }
                    message.success("已恢复");
                    router.refresh();
                  } catch {
                    message.error("恢复失败，请稍后重试");
                  } finally {
                    set恢复中(null);
                  }
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
          title={下属可停用.length
            ? "只有系统管理员可以新增成员；你可以给直属下属办离职。"
            : "只有系统管理员可以新增或停用成员，你可以在此查看团队构成。"}
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
      {能批量 && 勾了.length > 0 && (
        <Button danger icon={<StopOutlined />} style={{ marginBottom: 14, marginLeft: isAdmin ? 8 : 0 }} onClick={onBatchDeactivate}>
          批量停用（{勾了.length}）
        </Button>
      )}
      <Table<Row>
        rowKey="id"
        rowSelection={能批量 ? {
          selectedRowKeys: 勾了,
          onChange: (keys) => set勾了(keys as string[]),
          getCheckboxProps: (r) => ({ disabled: !能停(r) }),
        } : undefined}
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
        onOk={onOk} confirmLoading={存着}
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
              <Form.Item name="role" label="角色" extra="销售主管与销售目前使用相同业务权限；职位仅用于展示，管理权限由角色决定。">
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

type 清点 = { 客户: number; 进公海客户: number; 项目: number; 进公海项目: number; 订单项目: number };

/**
 * 停用对话框的正文：选交接方式（转交给一个人 / 放进公海）、选接手人，照清点的数说清会怎样。
 * 默认转交，和原来一样；公海方式下订单阶段的项目、已签约的客户还是给接手人，所以接手人两种方式都要选
 */
function OffboardForm({ name, 点, others, defaultTarget, onChange }: {
  name: string;
  点: { 转交: 清点; 公海: 清点 };
  others: Row[];
  defaultTarget: string;
  onChange: (v: { target: string; 方式: 停用方式 }) => void;
}) {
  const b = useBusiness();
  const [方式, set方式] = useState<停用方式>("转交");
  const [target, setTarget] = useState(defaultTarget);
  const 数 = 点[方式];
  const 改 = (v: { target?: string; 方式?: 停用方式 }) => {
    const 新 = { target: v.target ?? target, 方式: v.方式 ?? 方式 };
    setTarget(新.target);
    set方式(新.方式);
    onChange(新);
  };
  const 小字 = { fontSize: 13, marginBottom: 8 } as const;
  return (
    <div style={{ marginTop: 12 }}>
      <Radio.Group
        value={方式}
        onChange={(e) => 改({ 方式: e.target.value })}
        style={{ marginBottom: 12 }}
        options={[
          { value: "转交", label: "全部转交给一个人" },
          { value: "公海", label: "放进公海，谁领谁接" },
        ]}
      />
      {方式 === "转交" ? (
        <Typography.Paragraph type="secondary" style={小字}>
          {/* 说清转交的是往后要跟的活、历史业绩不动（排查 B2）。原来只写「名下 N 个客户、N 个商机」，叫法还写死成「客户」 */}
          {数.客户} 位{b.customer}{数.项目 ? `、${数.项目} 个项目` : ""}，连同进行中的商机、没做完的计划和待办、线索、渠道，一起转交给：
        </Typography.Paragraph>
      ) : (
        <Typography.Paragraph type="secondary" style={小字}>
          {数.进公海客户} 位{b.customer}放进公海{数.进公海项目 ? `、${数.进公海项目} 个项目放回项目公海` : ""}，
          「{name}」在这些{b.customer}上没做完的活和项目，谁领了跟谁走。
          {数.客户 ? `已签约、已流失或有订单阶段项目的 ${数.客户} 位${b.customer}、` : ""}
          {数.项目 ? `${数.项目} 个项目${数.订单项目 ? `（含 ${数.订单项目} 个订单阶段的，不能放公海）` : ""}、` : ""}
          线索、渠道，交给：
        </Typography.Paragraph>
      )}
      <Select
        value={target}
        style={{ width: "100%" }}
        onChange={(v) => 改({ target: v })}
        options={others.map((u) => ({ value: u.id, label: `${u.name}（${u.title}）` }))}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>
        {外贸订单(b) ? "已经下的订单、转了订单和丢单的商机" : "已经签下的业绩、赢单和丢单的商机"}、已有结局的项目，还算在「{name}」头上；
        TA 写过的跟进、建的档照旧显示是 TA。
      </Typography.Paragraph>
    </div>
  );
}

/** 批量停用对话框：同一个接手人、同一种交接方式。不逐个清点，各人名下的数到留痕里看 */
function BatchOffboardForm({ names, others, defaultTarget, onChange }: {
  names: string[];
  others: Row[];
  defaultTarget: string;
  onChange: (v: { target: string; 方式: 停用方式 }) => void;
}) {
  const b = useBusiness();
  const [方式, set方式] = useState<停用方式>("转交");
  const [target, setTarget] = useState(defaultTarget);
  const 改 = (v: { target?: string; 方式?: 停用方式 }) => {
    const 新 = { target: v.target ?? target, 方式: v.方式 ?? 方式 };
    setTarget(新.target);
    set方式(新.方式);
    onChange(新);
  };
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
        {names.map((n) => `「${n}」`).join("")}
      </Typography.Paragraph>
      <Radio.Group
        value={方式}
        onChange={(e) => 改({ 方式: e.target.value })}
        style={{ marginBottom: 12 }}
        options={[
          { value: "转交", label: "全部转交给一个人" },
          { value: "公海", label: "放进公海，谁领谁接" },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
        {方式 === "转交"
          ? `他们名下的${b.customer}、项目，连同进行中的商机、没做完的计划和待办、线索、渠道，一起转交给：`
          : `能放公海的${b.customer}和项目放进公海；已签约、已流失、订单阶段的，和线索、渠道，交给：`}
      </Typography.Paragraph>
      <Select
        value={target}
        style={{ width: "100%" }}
        onChange={(v) => 改({ target: v })}
        options={others.map((u) => ({ value: u.id, label: `${u.name}（${u.title}）` }))}
      />
    </div>
  );
}
