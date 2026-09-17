"use client";

import { useState } from "react";
import { Form, Input, Button, Avatar, App } from "antd";
import { avatarColor, initial, AVATAR_TEXT } from "@/lib/utils";
import { 改我的资料 } from "./actions";

/**
 * 个人资料：**你自己的名字和职位**。
 *
 * 这一栏 2026-09-17 才有。在那之前改名只存在于「团队成员 → 编辑成员」那个弹窗里，
 * 而那个弹窗只有管理员打得开——一个销售想把名字从邮箱前缀改成中文名，得去求管理员。
 * 名字不是权限，是称呼：它出现在左下角、每条跟进的署名、业绩榜上。
 *
 * **登录名不在这里改**，那是另一回事（它同时是控制面账号的标识，改一边不改另一边就登不进来）。
 * 头像也没有上传：颜色由名字算出来（lib/utils 的 avatarColor），改名就换色，不用管理一堆图片文件。
 */
export default function ProfileTab({ me }: { me: { name: string; title: string; email: string } }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  // 头像跟着输入实时变——改名之后它长什么样，当场就看得见
  const [预览, set预览] = useState(me.name);

  async function 保存() {
    const v = await form.validateFields();
    setSaving(true);
    const r = await 改我的资料({ name: v.name, title: v.title ?? "" });
    setSaving(false);
    if (!r.ok) {
      message.error(r.error);
      return;
    }
    message.success("已保存");
  }

  return (
    <div className="set-body">
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
        <Avatar size={44} style={{ background: avatarColor(预览 || me.name), color: AVATAR_TEXT, fontSize: 18, fontWeight: 600, flex: "none" }}>
          {initial(预览 || me.name)}
        </Avatar>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{预览 || me.name}</div>
          <div className="muted" style={{ fontSize: 13 }}>{me.email}</div>
        </div>
      </div>

      <Form form={form} layout="vertical" initialValues={{ name: me.name, title: me.title }} style={{ maxWidth: 380 }}>
        <Form.Item
          name="name"
          label="名字"
          extra="左栏、跟进署名、业绩榜上显示的就是它"
          rules={[
            { required: true, message: "名字不能为空" },
            { max: 20, message: "最多 20 个字" },
          ]}
        >
          <Input onChange={(e) => set预览(e.target.value)} />
        </Form.Item>
        <Form.Item name="title" label="职位" extra="比如「销售」「课程顾问」。不填也行" rules={[{ max: 20, message: "最多 20 个字" }]}>
          <Input placeholder="销售" />
        </Form.Item>
        <Form.Item label="登录名" extra="登录用的就是它，建好之后不能改——它同时是账号的标识">
          <Input value={me.email} disabled />
        </Form.Item>
        <Button type="primary" onClick={保存} loading={saving}>
          保存
        </Button>
      </Form>
    </div>
  );
}
