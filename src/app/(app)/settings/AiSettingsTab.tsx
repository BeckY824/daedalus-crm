"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Form, Input, Select, Space, Typography, App } from "antd";
import { CloseOutlined } from "@ant-design/icons";
import { saveLlmSettings, testLlmSettings, clearLlmSettings, listRemoteModels } from "./actions";
import type { AiUsage } from "@/lib/ai-usage";
import type { ModelOption } from "@/lib/llm";

export type LlmView = {
  /** ui：界面里填的；env：来自环境变量；null：未配置 */
  source: "ui" | "env" | null;
  baseUrl: string;
  model: string;
  keyMasked: string | null;
  /** 首页选单里能选的模型 */
  options: ModelOption[];
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
                  content: "清除后回到环境变量（如果有），否则 AI 功能整体隐藏。",
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
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12.5 }}>
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
