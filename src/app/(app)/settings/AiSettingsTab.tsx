"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Form, Input, Select, Space, Typography, App } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { saveLlmSettings, testLlmSettings, clearLlmSettings, listRemoteModels } from "./actions";
import type { AiUsage } from "@/lib/ai-usage";
import type { ModelOption } from "@/lib/llm";

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
 * AI 接入：三个字段一个按钮。任何 OpenAI 兼容接口都行。
 * 界面配置优先于环境变量；key 只回显尾 4 位，改地址或模型不必重填 key。
 */
export default function AiSettingsTab({ llm, usage }: { llm: LlmView; usage: AiUsage }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<{ baseUrl: string; model: string; apiKey?: string }>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [options, setOptions] = useState<ModelOption[]>(llm.options);
  const [remote, setRemote] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const 已有key = llm.keyMasked !== null;

  /** 拉一次接口支持的模型，填进下拉；拉不到就让人手输 */
  async function onLoadModels() {
    const v = form.getFieldsValue();
    setLoadingModels(true);
    const res = await listRemoteModels({ baseUrl: v.baseUrl, apiKey: v.apiKey });
    setLoadingModels(false);
    if (res.ok) {
      setRemote(res.models);
      message.success(`拉到 ${res.models.length} 个模型`);
    } else message.error(res.error);
  }

  async function onTest() {
    const v = await form.validateFields();
    setTesting(true);
    setTestResult(null);
    const res = await testLlmSettings(v);
    setTesting(false);
    setTestResult(res.ok ? { ok: true, text: `${res.ms} ms · 模型回复：${res.reply}` } : { ok: false, text: res.error });
  }

  async function onSave() {
    const v = await form.validateFields();
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
    const res = await saveLlmSettings({ ...v, options });
    setSaving(false);
    if (res.ok) {
      message.success("已保存，AI 功能已按新配置生效");
      form.setFieldValue("apiKey", "");
      router.refresh();
    } else message.error(res.error);
  }

  return (
    <div style={{ maxWidth: 560, paddingTop: 8 }}>
      {llm.source === null && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title="还没有配置 AI，所有 AI 入口当前是隐藏的"
          description="填好下面三项并测试通过后保存，跟进速记、临战简报、问数据、盯盘话术、转介绍邀请五个功能会立刻出现。其余功能不受影响。"
        />
      )}
      {/*
        云端账号那条单独说：桌面端用户看到「来自服务器环境变量（LLM_*）」是看不懂的，
        对他来说那就是「我登录的那个账号」。余额也摆在这里——
        原来只能从应用菜单里一个不起眼的「AI 剩余次数…」去查。
      */}
      {llm.source === "cloud" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title={`AI 走你登录的云端账号：${llm.account ?? ""}`}
          description={
            <div style={{ lineHeight: 1.9 }}>
              {llm.credits ? (
                <div>
                  免费次数还剩 <b style={{ fontSize: 15 }}>{llm.credits.还剩}</b> 次
                  <span style={{ color: "#6b7280" }}>（共送过 {llm.credits.上限} 次，已用 {llm.credits.用掉} 次）</span>
                </div>
              ) : (
                <div style={{ color: "#6b7280" }}>余额暂时查不到（断网，或者云端没开网关）</div>
              )}
              <div style={{ color: "#6b7280" }}>
                在下面填自己的 API Key 并保存，就<b>完全不走这个额度</b>，也不再计次——
                你的 Key 加密存在这台机器上，只会发给你自己填的那个接口地址。
              </div>
            </div>
          }
        />
      )}
      {llm.source === "env" && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          title="当前 AI 配置来自服务器环境变量（LLM_*）"
          description="在这里填写并保存后，界面配置会优先于环境变量。"
        />
      )}

      <Form
        form={form}
        layout="vertical"
        initialValues={{ baseUrl: llm.baseUrl, model: llm.model }}
        onValuesChange={() => setTestResult(null)}
      >
        <Form.Item
          name="baseUrl"
          label="接口地址"
          extra="任何 OpenAI 兼容接口。DeepSeek 官方 https://api.deepseek.com/v1；OpenAI https://api.openai.com/v1；本地 Ollama http://localhost:11434/v1"
          rules={[{ required: true, message: "请填写接口地址" }, { pattern: /^https?:\/\//, message: "要以 http:// 或 https:// 开头" }]}
        >
          <Input placeholder="https://api.deepseek.com/v1" />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="API Key"
          extra={已有key ? `已保存（尾号 ${llm.keyMasked}）。留空则沿用；填写则替换。Key 加密存储，备份文件里不会出现明文。` : "加密存储，只在服务端使用，不会下发到浏览器"}
        >
          <Input.Password placeholder={已有key ? "留空沿用已保存的 Key" : "sk-…"} autoComplete="off" />
        </Form.Item>
        <Form.Item name="model" label="模型名" rules={[{ required: true, message: "请填写模型名" }]} extra="如 deepseek-chat、gpt-4o-mini、qwen2.5。推理模型也可以，已按其思维链占用预留了输出预算。">
          <Input placeholder="deepseek-chat" />
        </Form.Item>

        <Form.Item
          label="首页可选模型"
          extra="填了之后，首页输入框下面会出现模型选单，每个人可以自己挑一个。备注是给人看的提示，比如「限时免费」。留空则不显示选单，一直用上面那个模型。"
        >
          <Select
            mode="tags"
            placeholder="先点「拉取可用模型」，或直接输入模型名回车"
            value={options.map((o) => o.id)}
            options={remote.map((m) => ({ value: m, label: m }))}
            onChange={(ids: string[]) =>
              setOptions(ids.map((id) => options.find((o) => o.id === id) ?? { id }))
            }
            style={{ width: "100%" }}
          />
          <Button size="small" type="link" style={{ paddingLeft: 0, marginTop: 4 }} onClick={onLoadModels} loading={loadingModels}>
            拉取可用模型
          </Button>
          {options.length > 0 && (
            <div className="ai-opts">
              {options.map((o, i) => (
                <div key={o.id} className="ai-opt">
                  <span className="ai-opt-i">{i + 1}</span>
                  <span className="ai-opt-id">{o.id}</span>
                  <Input
                    size="small"
                    placeholder="备注，可留空"
                    style={{ width: 160 }}
                    value={o.note ?? ""}
                    onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, note: e.target.value } : x)))}
                  />
                  <Button size="small" type="text" icon={<CloseOutlined />} aria-label={`移除 ${o.id}`} onClick={() => setOptions(options.filter((x) => x.id !== o.id))} />
                </div>
              ))}
            </div>
          )}
        </Form.Item>

        <Space wrap>
          <Button onClick={onTest} loading={testing}>测试连接</Button>
          <Button type="primary" onClick={onSave} loading={saving}>保存</Button>
          {llm.source === "ui" && (
            <Button
              danger
              type="text"
              onClick={() =>
                modal.confirm({
                  title: "清除界面里的 AI 配置？",
                  content: "清除后回到云端账号或环境变量（如果有），否则 AI 功能整体隐藏。你填的 Key 会从本机数据库里删掉。",
                  okText: "清除",
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    await clearLlmSettings();
                    message.success("已清除");
                    router.refresh();
                  },
                })
              }
            >
              清除
            </Button>
          )}
        </Space>
      </Form>

      {llm.source !== null && (
        <div style={{ marginTop: 22 }}>
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

      {testResult && (
        <Alert
          style={{ marginTop: 14 }}
          type={testResult.ok ? "success" : "error"}
          showIcon
          title={testResult.ok ? "连接正常" : "连接失败"}
          description={<Typography.Text style={{ wordBreak: "break-all" }}>{testResult.text}</Typography.Text>}
        />
      )}
    </div>
  );
}
