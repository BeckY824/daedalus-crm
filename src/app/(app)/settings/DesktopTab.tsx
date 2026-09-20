"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/** 壳的桥不会变，订阅什么都不用做 */
const 无订阅 = () => () => {};
import { Alert, App, Button, Card, Form, Input, Modal, Space, Typography } from "antd";
import { 桌面端发码, 桌面端改密码 } from "./actions";
import { 赠送说明 } from "@/lib/credits-copy";

/**
 * 设置页的「桌面端」栏：账号、AI 次数、备份、更新、诊断——原来散在系统菜单里的那些。
 *
 * 2026-09-17 菜单按 Claude 桌面端那套改成了标准项（应用 / 文件 / 编辑 / 显示 / 前往 / 窗口 / 帮助），
 * 账号和数据这类事一条都不该进菜单：它们是产品的一部分，就该在产品页面里。
 * 壳只留了六个杂事口子（preload-app.js 的 window.desktopShell），这里按按钮调它们。
 * 网页版没有那个桥，这一栏根本不会出现（page.tsx 只在本地模式传 桌面端）。
 */
import type { 云端余额 } from "@/lib/llm";

export type 桌面端信息 = {
  账号: string;
  余额: 云端余额 | null;
};

declare global {
  interface Window {
    desktopShell?: {
      version(): Promise<string>;
      backup(): Promise<{ ok: boolean; 文件?: string; error?: string }>;
      openDataDir(): Promise<void>;
      openLogs(): Promise<void>;
      diagnostics(): Promise<string>;
      useServer(url: string): Promise<{ ok: boolean; error?: string }>;
      /**
       * 换了云端账号：让壳把数据目录切到新账号那份、重起本地服务、重载窗口。
       * 数据一个账号一份（desktop/accounts.js），而 DATABASE_URL 是启动时读死的。
       * 只有登录页会调（见 login/LoginForm.tsx）。
       */
      switchAccount(): Promise<void>;
    };
  }
}

export default function DesktopTab({ 信息 }: { 信息: 桌面端信息 }) {
  const { message, modal } = App.useApp();
  const [版本, set版本] = useState<string | null>(null);
  const [改密码开着, set改密码开着] = useState(false);
  const [服务器, set服务器] = useState("");
  /**
   * 壳的桥只在 Electron 里有，而且只有客户端拿得到。用 useSyncExternalStore 而不是渲染时直接读
   * window：服务端渲染没有 window，直接读会整页退回客户端渲染；就算判了 typeof，服务端渲染出的
   * 是「没桥」、客户端第一帧是「有桥」，hydration 会对不上。给它一份服务端快照（没桥），
   * React 会先按它 hydrate，再用客户端快照重画一次。
   */
  const shell = useSyncExternalStore(无订阅, () => window.desktopShell, () => undefined);
  const 有更新桥 = useSyncExternalStore(无订阅, () => Boolean(window.desktopUpdate), () => false);

  useEffect(() => {
    shell?.version().then(set版本).catch(() => {});
  }, [shell]);

  async function 退出() {
    modal.confirm({
      title: "退出云端账号？",
      content: "这台机器的设备令牌会被吊销，AI 停用；本机数据都在，重新登录就能接着用。",
      okText: "退出",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        await fetch("/api/auth/logout", { method: "POST" });
        // 整页跳：会话和令牌都没了，软导航会被 proxy 弹来弹去
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
      },
    });
  }

  async function 备份() {
    if (!shell) return;
    const r = await shell.backup();
    if (r.ok && r.文件) message.success(`已备份到 ${r.文件}`);
    else if (!r.ok && r.error) message.error(r.error);
  }

  async function 复制诊断() {
    if (!shell) return;
    await navigator.clipboard.writeText(await shell.diagnostics());
    message.success("诊断信息已复制，贴给我们就行");
  }

  const { 账号, 余额 } = 信息;
  const 版本文字 = 版本 ? `当前版本 ${版本}` : null;

  return (
    <div className="set-col" style={{ paddingTop: 8 }}>
      <Space orientation="vertical" size={16} style={{ width: "100%" }}>
        <Card size="small" title="云端账号">
          <Typography.Paragraph style={{ marginBottom: 6 }}>
            已登录：<b>{账号 || "（未知）"}</b>
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            {余额
              ? `AI 免费次数还剩 ${余额.还剩} 次（一共送过 ${余额.上限} 次，用掉 ${余额.用掉} 次${赠送说明(余额) ? `；${赠送说明(余额)}` : ""}）。`
              : "AI 免费次数暂时查不到（可能没联网）。"}
            也可以在「AI 接入」里填自己的 Key，那样不走这个额度。数据存在这台机器上；
            只有<b>你点的 AI 功能</b>和<b>导入时的「自动判断」</b>会把相关的那一小段发出去，两个都在「AI 接入」里关得掉。
          </Typography.Paragraph>
          <Space>
            <Button onClick={() => set改密码开着(true)}>修改密码</Button>
            <Button danger onClick={退出}>
              退出登录
            </Button>
          </Space>
        </Card>

        <Card size="small" title="本机数据">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            一个 SQLite 文件，就在这台机器上。备份出去的文件退出应用后改名成 crm.db 放回数据目录就能恢复。
          </Typography.Paragraph>
          <Space wrap>
            <Button onClick={备份} disabled={!shell}>
              备份数据库…
            </Button>
            <Button onClick={() => shell?.openDataDir()} disabled={!shell}>
              打开数据文件夹
            </Button>
            <Button onClick={() => shell?.openLogs()} disabled={!shell}>
              查看服务日志
            </Button>
          </Space>
        </Card>

        <Card size="small" title="更新" extra={版本文字}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            后台会自己查。查到新版侧栏底下会出一个按钮，写着这次要下多少，点了才开始下。
          </Typography.Paragraph>
          <Button
            onClick={async () => {
              await window.desktopUpdate?.check();
              message.info("已经去查了，有新版会出现在侧栏底下");
            }}
            disabled={!有更新桥}
          >
            检查更新
          </Button>
        </Card>

        <Card size="small" title="连接服务器">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            团队共用一台自己部署的服务器时用。连上之后这个窗口显示的就是那台机器上的 CRM；本机数据留在本机，想切回来在应用菜单里。
          </Typography.Paragraph>
          <Space.Compact style={{ width: "100%", maxWidth: 480 }}>
            <Input placeholder="https://crm.your-company.com" value={服务器} onChange={(e) => set服务器(e.target.value)} />
            <Button
              disabled={!shell || !/^https?:\/\/.+/.test(服务器.trim())}
              onClick={async () => {
                const r = await shell!.useServer(服务器.trim());
                if (!r.ok && r.error) message.error(r.error);
              }}
            >
              连接
            </Button>
          </Space.Compact>
        </Card>

        <Card size="small" title="遇到问题">
          <Space>
            <Button onClick={复制诊断} disabled={!shell}>
              复制诊断信息
            </Button>
            <a href="https://github.com/BeckY824/daedalus-crm/issues/new" target="_blank" rel="noreferrer">
              反馈问题 ↗
            </a>
          </Space>
        </Card>
      </Space>

      <ChangePasswordModal open={改密码开着} 账号={账号} onClose={() => set改密码开着(false)} />
    </div>
  );
}

/**
 * 改云端账号的密码：服务端只有一条路——先收一个验证码，再设新密码。
 * 改完**所有机器都要重新登录，这台也在内**（改密码 = 全部吊销，2026-09-17 起），
 * 所以成功之后直接送去登录页，不留一个「看起来还登录着」的界面。
 */
function ChangePasswordModal({ open, 账号, onClose }: { open: boolean; 账号: string; onClose: () => void }) {
  const [form] = Form.useForm();
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function 发码() {
    setSending(true);
    setError(null);
    const r = await 桌面端发码();
    setSending(false);
    if (!r.ok) return setError(r.error);
    setHint(r.hint ?? `验证码已经发到 ${账号}，10 分钟内有效`);
  }

  async function 提交(v: { code: string; password: string }) {
    setSaving(true);
    setError(null);
    const r = await 桌面端改密码({ code: v.code.trim(), password: v.password });
    setSaving(false);
    if (!r.ok) return setError(r.error);
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login?reason=changed");
  }

  return (
    <Modal open={open} title="修改云端账号密码" onCancel={onClose} footer={null} destroyOnHidden>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        title="改完之后所有地方都要重新登录"
        description="网页端的登录状态、以及每一台已登录的机器，包括这一台。本机数据不受影响。"
      />
      {error && <Alert type="error" showIcon style={{ marginBottom: 14 }} title={error} />}
      {hint && <Alert type="info" showIcon style={{ marginBottom: 14 }} title={hint} />}
      <Form form={form} layout="vertical" onFinish={提交} requiredMark={false}>
        <Form.Item label="账号">
          <Space.Compact style={{ width: "100%" }}>
            <Input value={账号} disabled />
            <Button onClick={发码} loading={sending}>
              发送验证码
            </Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="code" label="验证码" rules={[{ required: true, message: "填邮件里的 6 位验证码" }]}>
          <Input maxLength={6} inputMode="numeric" />
        </Form.Item>
        <Form.Item name="password" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 8, message: "至少 8 位" }]}>
          <Input.Password />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving} block>
          设置新密码
        </Button>
      </Form>
    </Modal>
  );
}
