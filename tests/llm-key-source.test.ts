/**
 * 设置页看到的 AI 配置状态：**三种来源说三种话，而且一律不带明文 Key。**
 *
 * 桌面端登录云端账号之后，那枚设备令牌被当作 LLM_API_KEY 用。原来这种情况
 * 在设置页显示的是「当前 AI 配置来自服务器环境变量（LLM_*）」——对桌面端用户
 * 毫无意义，他根本没有什么服务器环境变量；而他真正想知道的「还剩几次免费」
 * 只能从应用菜单里一个不起眼的入口去查。
 *
 * 另外钉住最要紧的一条：describeLlmConfig 是喂给页面 props 的，
 * **任何时候都不能出现明文 Key**——它会被 React 序列化进 HTML 发给浏览器。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 这几个变量在开发机上可能本来就有值（.env），所以每条用例自己把台面擦干净，
 * 跑完再原样放回去——只放回**原来真有**的那几个，否则「什么都没配」那条
 * 会被上一条留下的值污染。
 */
const 变量 = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "CLOUD_ACCOUNT"] as const;
const 原值 = Object.fromEntries(变量.map((k) => [k, process.env[k]]));

function 清台面() {
  for (const k of 变量) delete process.env[k];
}

beforeEach(() => {
  清台面();
});

afterEach(() => {
  清台面();
  for (const k of 变量) if (原值[k] !== undefined) process.env[k] = 原值[k];
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AI 配置的来源", () => {
  it("桌面端登了云端账号：来源是 cloud，带账号和余额，且没有明文 Key", async () => {
    process.env.LLM_API_KEY = "dk_FAKE_TEST_TOKEN";
    process.env.LLM_BASE_URL = "https://app.example.com/api/gateway/v1";
    process.env.CLOUD_ACCOUNT = "lin@qiming.com";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ 上限: 33, 用掉: 9, 还剩: 24 }), { status: 200 }));

    const { describeLlmConfig } = await import("@/lib/llm");
    const v = await describeLlmConfig();
    expect(v.source).toBe("cloud");
    expect(v.account).toBe("lin@qiming.com");
    expect(v.credits).toEqual({ 上限: 33, 用掉: 9, 还剩: 24 });
    expect(v.keyMasked).toBe("****OKEN");
    expect(JSON.stringify(v), "喂给页面的东西里不能有明文 Key").not.toContain("dk_FAKE_TEST_TOKEN");
  });

  it("余额查不到就是 null，不能把设置页拖垮", async () => {
    process.env.LLM_API_KEY = "dk_x";
    process.env.LLM_BASE_URL = "https://app.example.com/api/gateway/v1";
    process.env.CLOUD_ACCOUNT = "lin@qiming.com";
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const { describeLlmConfig } = await import("@/lib/llm");
    const v = await describeLlmConfig();
    expect(v.source).toBe("cloud");
    expect(v.credits).toBeNull();
  });

  it("没有 CLOUD_ACCOUNT 就还是 env，说法不变", async () => {
    process.env.LLM_API_KEY = "FAKE-TEST-KEY-0005";
    process.env.LLM_BASE_URL = "https://relay.example.com/v1";
    const { describeLlmConfig } = await import("@/lib/llm");
    const v = await describeLlmConfig();
    expect(v.source).toBe("env");
    expect(v.account).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("FAKE-TEST-KEY-0005");
  });

  it("界面里填的那把：来源 ui，只回显尾 4 位，明文不出现在 props 里", async () => {
    /**
     * 这一条最要紧：describeLlmConfig 的返回值会被 React 序列化进 HTML 发给浏览器。
     * 漏一次就是把用户的 Key 印在页面源码里。
     */
    const { describeLlmConfig, saveLlmConfig, clearLlmConfig } = await import("@/lib/llm");
    await saveLlmConfig({ baseUrl: "https://my.example.com/v1", model: "m", apiKey: "FAKE-TEST-KEY-0002" });
    try {
      const v = await describeLlmConfig();
      expect(v.source).toBe("ui");
      expect(v.keyMasked).toBe("****0002");
      expect(JSON.stringify(v)).not.toContain("FAKE-TEST-KEY-0002");
      // 界面里填的优先于环境变量，即便这时也配了环境变量
      process.env.LLM_API_KEY = "FAKE-TEST-KEY-0004";
      expect((await describeLlmConfig()).source).toBe("ui");
    } finally {
      await clearLlmConfig();
    }
  });
});

describe("存着的那把 Key 不会被发到别处", () => {
  it("目标地址和存的不一样时，当作没有 Key", async () => {
    /**
     * 「测试连接」和「拉取模型列表」这两个动作的 baseUrl 完全由调用方给，
     * 而 Key 留空时服务端会去库里取。原来取出来就直接发——于是同工作区的
     * 第二个管理员、或者拿到管理员会话的人，填一个自己的地址点一下，
     * 就能把明文 Key 收走。而填 Key 的人以为「填进去就只剩尾 4 位了」。
     */
    const { resolveLlmConfigForTest, saveLlmConfig, clearLlmConfig } = await import("@/lib/llm");
    await saveLlmConfig({ baseUrl: "https://mine.example.com/v1", model: "m", apiKey: "FAKE-TEST-KEY-0001" });
    try {
      expect(await resolveLlmConfigForTest({ baseUrl: "https://evil.example.net/v1", model: "m" })).toBeNull();
      expect((await resolveLlmConfigForTest({ baseUrl: "https://mine.example.com/v1", model: "m" }))?.apiKey).toBe("FAKE-TEST-KEY-0001");
      // 末尾斜杠不算另一个地址
      expect((await resolveLlmConfigForTest({ baseUrl: "https://mine.example.com/v1/", model: "m" }))?.apiKey).toBe("FAKE-TEST-KEY-0001");
      // 自己当场填的那把，想发哪儿发哪儿——那是他自己的
      expect((await resolveLlmConfigForTest({ baseUrl: "https://evil.example.net/v1", model: "m", apiKey: "FAKE-TEST-KEY-0003" }))?.apiKey).toBe("FAKE-TEST-KEY-0003");
    } finally {
      await clearLlmConfig();
    }
  });

  it("上游报错原文里的 Key 会被抹掉再往外送", async () => {
    /**
     * 有些中转站鉴权失败会把收到的 Key 回显在错误体里。那段文字会同时进
     * 浏览器（设置页的测试结果、AI 对话的错误提示）和日志（桌面端连 stdout
     * 一起写进日志文件）——一次就把「不进日志、不回浏览器」两条承诺都破了。
     */
    const { testLlm } = await import("@/lib/llm");
    vi.stubGlobal("fetch", async () =>
      new Response(`{"error":"invalid api key: FAKE-TEST-KEY-0000"}`, { status: 401 }),
    );
    const r = await testLlm({ apiKey: "FAKE-TEST-KEY-0000", baseUrl: "https://x.example/v1", model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error, "报错里不能留着 Key").not.toContain("FAKE-TEST-KEY-0000");
      expect(r.error).toContain("****");
    }
  });
});
