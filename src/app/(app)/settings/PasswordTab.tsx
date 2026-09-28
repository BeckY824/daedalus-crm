"use client";

import { Table, Button, Form, Input, App, Alert, Typography } from "antd";
import { useRouter } from "next/navigation";
import { dayjs } from "@/lib/utils";
import { changeMyPassword, 退出这台机器, type 机器 } from "./actions";

/**
 * 设置 · 登录与密码：改自己的密码；托管版还列出用这个云端账号登录着的桌面端机器，可以单独退出一台。
 * 机器是 null 时（自部署版、共享工作区）那一块整个不画。
 */
export default function PasswordTab({ 机器 }: { 机器: 机器[] | null }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [pwdForm] = Form.useForm();

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

  return (
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
  );
}
