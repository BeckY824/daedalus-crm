"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Form, Input, Radio, Select, Space, Typography, App } from "antd";
import { saveLlmSettings, testLlmSettings, clearLlmSettings, 查MCP接入, 开启MCP, 关闭MCP } from "./actions";
import type { AiUsage } from "@/lib/ai-usage";
import type { ModelOption } from "@/lib/llm";
import { PROVIDERS, 认服务商 } from "@/lib/providers";

export type LlmView = {
  /** ui：界面里填的；cloud：桌面端登录的云端账号给的；env：运维在 .env 里配的；null：未配置 */
  source: "ui" | "cloud" | "env" | null;
  baseUrl: string;
  model: string;
  keyMasked: string | null;
  /** 首页选单里能选的模型 */
  options: ModelOption[];
  /** source=cloud：登录的是哪个账号 */
  account?: string;
  /** source=cloud：免费次数余额。查不到就是 null */
  credits?: { 上限: number; 用掉: number; 还剩: number } | null;
};

/**
 * AI 接入：**两个选择，不是六个字段**。
 *
 * 2026-09-17 改的。原来这一栏摊开接口地址、API Key、模型名、首页可选模型、拉取模型、
 * 测试连接——而其中三样对绝大多数人是同一个答案：用哪家，那家就那几个值。
 * 现在只问两件事：用我们的额度，还是用你自己的 Key；用自己的就选一家、填一个 Key、挑个模型。
 * 自定义接口地址收进「高级」——那是留给知道自己在做什么的人的，不该挡在所有人前面。
 *
 * 本地推理（Ollama 那类）不在选单里：这套 CRM 的 AI 是 agent 循环，要模型稳定按格式调工具，
 * 本地小模型在这件事上的失败率高到会让人以为是产品坏了。要用的人走「高级」。
 */
export default function AiSettingsTab({ llm, usage }: { llm: LlmView; usage: AiUsage }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<{ providerId: string; baseUrl: string; model: string; apiKey?: string }>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * **只有 source=ui 才算「你自己存过 Key」。** cloud 和 env 也有 keyMasked——
   * 那是云端令牌或运维配的那把的尾号，把它显示成「你已保存的 Key」是张冠李戴：
   * 人会以为自己填过，于是留空保存，结果存进去一个空 Key。
   */
  const 已有key = llm.source === "ui" && llm.keyMasked !== null;
  /** 有云端账号（或运维配了环境变量）时，「用我们的」才是一个真选项 */
  const 有平台额度 = llm.source === "cloud" || llm.source === "env" || (llm.source === "ui" && Boolean(llm.account));
  const 初始服务商 = 认服务商(llm.baseUrl)?.id ?? (llm.source === "ui" ? "custom" : PROVIDERS[0].id);
  const [用自己的, set用自己的] = useState(llm.source === "ui");
  /**
   * 表单初值：只有真的用着自己的 Key 时才沿用当前地址和模型。否则当前那套是「我们的」
   * ——地址是云端网关、模型是网关那边的名字（glm-5.3-flash），拿它当 DeepSeek 的默认模型
   * 会让人保存出一个必然调不通的配置。
   */
  const 初始模型 = llm.source === "ui" ? llm.model : (PROVIDERS.find((p) => p.id === 初始服务商) ?? PROVIDERS[0]).models[0].id;
  const [providerId, setProviderId] = useState(初始服务商);
  const provider = PROVIDERS.find((p) => p.id === providerId);

  /** 换一家：地址和模型跟着换成那家的默认值，不用人去查 */
  function 选服务商(id: string) {
    setProviderId(id);
    setTestResult(null);
    const p = PROVIDERS.find((x) => x.id === id);
    if (p) form.setFieldsValue({ baseUrl: p.baseUrl, model: p.models[0].id });
  }

  function 收表单() {
    const v = form.getFieldsValue();
    const p = PROVIDERS.find((x) => x.id === providerId);
    return {
      baseUrl: (providerId === "custom" ? v.baseUrl : p?.baseUrl) ?? v.baseUrl,
      model: v.model,
      apiKey: v.apiKey,
      /** 首页那个选单：就是这家的常用几个，不用人再填一遍 */
      options: providerId === "custom" ? llm.options : (p?.models ?? []),
    };
  }

  async function onTest() {
    await form.validateFields();
    setTesting(true);
    setTestResult(null);
    const { baseUrl, model, apiKey } = 收表单();
    const res = await testLlmSettings({ baseUrl, model, apiKey });
    setTesting(false);
    setTestResult(res.ok ? { ok: true, text: `${res.ms} ms · 模型回复：${res.reply}` } : { ok: false, text: res.error });
  }

  async function onSave() {
    await form.validateFields();
    const v = 收表单();
    if (!v.apiKey && !已有key) {
      message.error("请填写 API Key");
      return;
    }
    /**
     * 没测过就保存，等于把整套 AI 能力交给一个没验证过的地址：
     * 首页、简报、问数据会一起哑掉，而报错要等到下一个人去用才看得见。
     * 拦一次，让人自己决定——不禁止，只是说清楚。
     */
    if (!testResult?.ok) {
      const 继续 = await new Promise<boolean>((resolve) =>
        modal.confirm({
          title: testResult ? "这次测试没通过，还要保存吗？" : "还没测试过连接，要直接保存吗？",
          content:
            "保存之后，首页提问、临战简报、问数据、盯盘话术都会走这套配置。地址或 Key 不对的话它们会一起失灵，而且要等下一个人去用才发现。",
          okText: "仍然保存",
          cancelText: "先测一下",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      );
      if (!继续) return;
    }
    setSaving(true);
    const res = await saveLlmSettings(v);
    setSaving(false);
    if (res.ok) {
      message.success("已保存，AI 功能已按新配置生效");
      form.setFieldValue("apiKey", "");
      router.refresh();
    } else message.error(res.error);
  }

  return (
    <div className="set-col" style={{ paddingTop: 8 }}>
      {llm.source === null && !有平台额度 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="还没有配置 AI，所有 AI 入口当前是隐藏的"
          description="选一家、填一个 Key 并保存，跟进速记、临战简报、问数据、盯盘话术、转介绍邀请五个功能会立刻出现。其余功能不受影响。"
        />
      )}

      <Radio.Group
        value={用自己的 ? "own" : "ours"}
        onChange={(e) => {
          set用自己的(e.target.value === "own");
          setTestResult(null);
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}
      >
        <Radio value="ours" disabled={!有平台额度}>
          <b>用我们的</b>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            {llm.source === "cloud" && llm.account ? (
              llm.credits ? (
                <>
                  走你登录的云端账号 <b>{llm.account}</b>，免费次数还剩 <b>{llm.credits.还剩}</b> 次（共送过 {llm.credits.上限}、已用 {llm.credits.用掉}）
                </>
              ) : (
                <>走你登录的云端账号 {llm.account}，余额暂时查不到（断网，或云端没开网关）</>
              )
            ) : llm.source === "env" ? (
              "走这台服务器上配好的模型（运维在环境变量里设的）"
            ) : (
              "需要先登录云端账号。桌面端在「设置 → 桌面端」里登录"
            )}
          </div>
        </Radio>
        <Radio value="own">
          <b>用你自己的 API Key</b>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            不计我们的免费次数。Key 加密存在这台机器上，请求由本机直接发给你选的那家，不经过我们
          </div>
        </Radio>
      </Radio.Group>

      {用自己的 && (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ baseUrl: llm.source === "ui" ? llm.baseUrl : "", model: 初始模型 }}
          onValuesChange={() => setTestResult(null)}
        >
          {/* 这一项不受 Form 管（值在外面的 state 里），所以 antd 不会替它把 label 绑上去，
              自己补一个无障碍名字：读屏和 e2e 都按它找 */}
          <Form.Item label="用哪一家">
            <Select
              aria-label="用哪一家"
              value={providerId}
              onChange={选服务商}
              options={[...PROVIDERS.map((p) => ({ value: p.id, label: p.name })), { value: "custom", label: "其它（自己填接口地址）" }]}
            />
          </Form.Item>

          {providerId === "custom" && (
            <Form.Item
              name="baseUrl"
              label="接口地址"
              extra="任何 OpenAI 兼容接口。填错了「测试连接」会告诉你。"
              rules={[{ required: true, message: "请填写接口地址" }, { pattern: /^https?:\/\//, message: "要以 http:// 或 https:// 开头" }]}
            >
              <Input placeholder="https://api.example.com/v1" />
            </Form.Item>
          )}

          <Form.Item
            name="apiKey"
            label="API Key"
            extra={
              已有key ? (
                `已保存（尾号 ${llm.keyMasked}）。留空则沿用；填写则替换。加密存储，备份文件里不会出现明文。`
              ) : provider ? (
                <>
                  {provider.keyHint} ·{" "}
                  <a href={provider.keyUrl} target="_blank" rel="noreferrer">
                    去 {provider.name} 拿一个 ↗
                  </a>
                </>
              ) : (
                "加密存储，只在服务端使用，不会下发到浏览器"
              )
            }
            rules={已有key ? [] : [{ required: true, message: "请填写 API Key" }]}
          >
            <Input.Password placeholder={已有key ? "留空沿用已保存的 Key" : provider?.keyHint ?? "sk-…"} autoComplete="off" />
          </Form.Item>

          <Form.Item name="model" label="模型" rules={[{ required: true, message: "请选择模型" }]}>
            {providerId === "custom" ? (
              <Input placeholder="deepseek-chat" />
            ) : (
              <Select
                options={(provider?.models ?? []).map((m) => ({
                  value: m.id,
                  label: m.note ? `${m.id}（${m.note}）` : m.id,
                }))}
              />
            )}
          </Form.Item>

          <Space wrap>
            <Button onClick={onTest} loading={testing}>
              测试连接
            </Button>
            <Button type="primary" onClick={onSave} loading={saving}>
              保存
            </Button>
            {llm.source === "ui" && (
              <Button
                danger
                type="text"
                onClick={() =>
                  modal.confirm({
                    title: "不用自己的 Key 了？",
                    content: "你填的 Key 会从本机数据库里删掉，之后回到云端账号的免费次数（如果登录着），否则 AI 功能整体隐藏。",
                    okText: "删掉这把 Key",
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await clearLlmSettings();
                      message.success("已清除");
                      set用自己的(false);
                      router.refresh();
                    },
                  })
                }
              >
                删掉这把 Key
              </Button>
            )}
          </Space>
        </Form>
      )}

      {testResult && (
        <Alert
          style={{ marginTop: 14 }}
          type={testResult.ok ? "success" : "error"}
          showIcon
          title={testResult.ok ? "连接正常" : "连接失败"}
          description={<Typography.Text style={{ wordBreak: "break-all" }}>{testResult.text}</Typography.Text>}
        />
      )}

      <McpBlock />

      {llm.source !== null && (
        <div style={{ marginTop: 24 }}>
          <Typography.Text strong>本月用量</Typography.Text>
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>
            共 {usage.reduce((s, u) => s + u.count, 0)} 次，按自然月统计，来自操作日志
          </Typography.Text>
          <Space wrap size={[16, 6]} style={{ marginTop: 6 }}>
            {usage.map((u) => (
              <span key={u.feature} style={{ fontSize: 13 }}>
                {u.label} <Typography.Text strong>{u.count}</Typography.Text>
              </span>
            ))}
          </Space>
        </div>
      )}
    </div>
  );
}

/**
 * 让别的 agent 连进来（MCP）。
 *
 * 这一小块是整个产品里**唯一反方向**的接口：平时是我们拿着用户的 Key 去调模型，
 * 这条是 Claude Code / Codex / Claude 桌面端拿我们当工具箱，用**他们自己的**订阅来查。
 * 对一个人用的场景意义最大：他多半已经在付那份订阅，而数据一步不出这台机器。
 *
 * 开出去的只有九个只读查询，写不了任何东西（见 lib/mcp/tools.ts）。
 */
function McpBlock() {
  const { message, modal } = App.useApp();
  const [状态, set状态] = useState<{ 可用: boolean; 已开: boolean; 地址: string; 令牌: string | null } | null>(null);
  const [忙, set忙] = useState(false);

  useEffect(() => {
    查MCP接入().then(set状态).catch(() => {});
  }, []);

  if (!状态?.可用) return null;

  const 命令 = 状态.令牌
    ? `claude mcp add --transport http daedalus ${状态.地址} --header "Authorization: Bearer ${状态.令牌}"`
    : "";

  async function 开() {
    set忙(true);
    const r = await 开启MCP();
    set忙(false);
    if (!r.ok) return void message.error(r.error);
    set状态({ 可用: true, 已开: true, 地址: r.地址, 令牌: r.令牌 });
    message.success("已生成接入令牌");
  }

  function 关() {
    modal.confirm({
      title: "关掉 MCP 接入？",
      content: "令牌立刻作废，已经配好的 Claude Code / Codex 会连不上（重新开启会给一把新的，那边要改配置）。",
      okText: "关掉",
      okButtonProps: { danger: true },
      cancelText: "算了",
      onOk: async () => {
        await 关闭MCP();
        set状态((v) => (v ? { ...v, 已开: false, 令牌: null } : v));
        message.success("已关闭");
      },
    });
  }

  return (
    <div className="mcp-block">
      <h4>让别的 agent 连进来</h4>
      <p>
        把这个 CRM 接到 Claude Code、Codex 或 Claude 桌面端：在那边直接问「张三最近跟进到哪了」「这个月谁签得最多」，
        它会来查这台机器上的库，用的是<b>你自己</b>的订阅额度。开出去的是九个<b>只读</b>查询，
        写不了任何东西——记一笔、改状态、排计划仍然只能在这里点。
      </p>

      {状态.已开 && 状态.令牌 ? (
        <>
          <div className="mcp-cmd">
            <code>{命令}</code>
            <Button
              size="small"
              onClick={() => {
                navigator.clipboard.writeText(命令).then(
                  () => message.success("命令已复制，去终端里粘贴执行"),
                  () => message.error("复制不了，手动选中拷贝吧"),
                );
              }}
            >
              复制
            </Button>
          </div>
          <p className="mcp-hint">
            粘到终端里执行一次就接上了。Codex 用 <code>codex mcp add</code>，参数一样。
            这把令牌等于这个库的只读钥匙，别贴到公开的地方；重新生成会让旧的立刻失效。
          </p>
          <Space wrap>
            <Button size="small" onClick={开} loading={忙}>重新生成令牌</Button>
            <Button size="small" danger type="text" onClick={关}>关掉接入</Button>
          </Space>
        </>
      ) : (
        <Button onClick={开} loading={忙}>生成接入令牌</Button>
      )}
    </div>
  );
}
