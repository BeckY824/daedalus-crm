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

/**
 * 首页那个模型选单里该有哪几个。
 *
 * 2026-09-19 报上来的：填了自己 Key 的人，选单里仍然列着中转站那几个型号。
 * 根因在 `saveLlmConfig` 的 `options: input.options ?? stored.options ?? []`——
 * 上一次云端账号的型号表被留着了。而那些型号在他自己的接口上根本不存在，
 * 选中一个就是一次注定失败的请求；`resolveModel` 又正是拿这张单子放行的，
 * 等于放行了一串 404。
 */
describe("模型选单", () => {
  it("填了自己的 Key：只留他填的那一个", async () => {
    const { saveLlmConfig, listModelOptions, clearLlmConfig } = await import("@/lib/llm");
    // 先模拟「之前用过云端账号」，型号表留在库里
    await saveLlmConfig({
      baseUrl: "https://relay.example.com/v1",
      model: "glm-5.3-flash",
      apiKey: "FAKE-TEST-KEY-0003",
      options: [{ id: "glm-5.3-flash" }, { id: "deepseek-v4.1-flash" }, { id: "hy3" }],
    });
    // 再换成自己的 Key 和自己的模型（界面上不传 options，于是旧表被继承）
    await saveLlmConfig({ baseUrl: "https://mine.example.com/v1", model: "my-own-model", apiKey: "FAKE-TEST-KEY-0004" });
    try {
      const 单子 = await listModelOptions();
      expect(单子.map((o) => o.id), "自己的 Key 下不该出现中转站的型号").toEqual(["my-own-model"]);
    } finally {
      await clearLlmConfig();
    }
  });

  it("填了自己的 Key：选单外的模型名一律放行不了", async () => {
    const { saveLlmConfig, resolveModel, clearLlmConfig } = await import("@/lib/llm");
    await saveLlmConfig({
      baseUrl: "https://mine.example.com/v1",
      model: "my-own-model",
      apiKey: "FAKE-TEST-KEY-0005",
      options: [{ id: "glm-5.3-flash" }, { id: "hy3" }],
    });
    try {
      expect(await resolveModel("my-own-model")).toBe("my-own-model");
      // 浏览器把中转站的型号送上来也不认——他的接口上没有这个东西
      expect(await resolveModel("glm-5.3-flash")).toBeUndefined();
      expect(await resolveModel("hy3")).toBeUndefined();
    } finally {
      await clearLlmConfig();
    }
  });
});

describe("AI 报错说人话（2026-10-02 排查 AI B1）", () => {
  it("网关的报错取中文那句；没中文的按状态码说；不再整串 JSON", async () => {
    const { AI报错人话 } = await import("@/lib/llm");
    expect(AI报错人话(402, '{"error":{"message":"免费的 AI 次数已经用完，明天再来","type":"gateway_error"}}')).toBe("免费的 AI 次数已经用完，明天再来");
    expect(AI报错人话(401, '{"error":{"message":"invalid token","type":"gateway_error"}}')).toContain("退出登录再登录");
    expect(AI报错人话(502, "<html>bad gateway</html>")).toBe("AI 服务暂时不可用，稍后再试");
    expect(AI报错人话(400, "{}")).not.toContain("{");
  });
});

describe("等不到就重发一次（2026-10-02 实测中转站偶尔卡 30–200 秒）", () => {
  it("第一次超时：重发一次，第二次回来就用它；带同一个问题编号", async () => {
    const { chatJSON, 首字等待毫秒 } = await import("@/lib/llm");
    const 原 = { ...首字等待毫秒 };
    首字等待毫秒.短输出 = 50;
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://relay.example/v1";
    process.env.LLM_MODEL = "m";
    const 编号们: (string | null)[] = [];
    let 次 = 0;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      次++;
      编号们.push(new Headers(init.headers).get("X-Question-Id"));
      if (次 === 1) {
        // 第一次一直不回，直到被 signal 掐掉
        await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] }), { status: 200 });
    });
    try {
      expect(await chatJSON("x", { maxTokens: 500, timeoutMs: 30_000 })).toEqual({ ok: 1 });
      expect(次).toBe(2);
      expect(编号们[0]).toBeTruthy();
      expect(编号们[1]).toBe(编号们[0]);
    } finally {
      Object.assign(首字等待毫秒, 原);
      delete process.env.LLM_API_KEY;
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_MODEL;
    }
  });

  it("G.3 连着卡两次（中转站约五分之一的请求会卡住）：第三次回来就用它，三次同一个问题编号", async () => {
    const { chatJSON, 首字等待毫秒 } = await import("@/lib/llm");
    const 原 = { ...首字等待毫秒 };
    首字等待毫秒.短输出 = 50;
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://relay.example/v1";
    process.env.LLM_MODEL = "m";
    const 编号们: (string | null)[] = [];
    let 次 = 0;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      次++;
      编号们.push(new Headers(init.headers).get("X-Question-Id"));
      if (次 <= 2) await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] }), { status: 200 });
    });
    try {
      expect(await chatJSON("x", { maxTokens: 500, timeoutMs: 30_000 })).toEqual({ ok: 1 });
      expect(次).toBe(3);
      expect(new Set(编号们).size).toBe(1);
    } finally {
      Object.assign(首字等待毫秒, 原);
      delete process.env.LLM_API_KEY;
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_MODEL;
    }
  });
});

/*
  回归核对 D-064：① 快速重发曾把正常偏慢的解析（默认 4000 输出、正常 9–14 秒）在 25 秒处切断重来——
  现在默认长度走「中输出」那一档（45 秒），只有 ≤2000 的短输出才走 25 秒；② 两次都等不到时说「AI 响应超时」，
  不说「重发过」之类让人摸不着头脑的话
*/
describe("快速重发不切正常偏慢的解析、超时说人话（D-064）", () => {
  const 接上 = () => {
    process.env.LLM_API_KEY = "k";
    process.env.LLM_BASE_URL = "https://relay.example/v1";
    process.env.LLM_MODEL = "m";
  };
  const 收拾 = () => {
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  };

  it("① 默认长度（解析 / 简报）用中输出那一档：短输出那档到点了也不重发，等它自己回来", async () => {
    const { chatJSON, 首字等待毫秒 } = await import("@/lib/llm");
    const 原 = { ...首字等待毫秒 };
    // 短输出那档掐得很短、中输出那档放得很长：默认长度要是误走了短输出，就会在 30ms 处被掐断重发
    首字等待毫秒.短输出 = 30;
    首字等待毫秒.中输出 = 60_000;
    接上();
    let 次 = 0;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      次++;
      await new Promise((ok, rej) => {
        const t = setTimeout(ok, 300); // 偏慢但正常
        init.signal?.addEventListener("abort", () => (clearTimeout(t), rej(Object.assign(new Error("timeout"), { name: "TimeoutError" }))));
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] }), { status: 200 });
    });
    try {
      expect(await chatJSON("解析这段", { timeoutMs: 120_000, feature: "parse" })).toEqual({ ok: 1 });
      expect(次, "正常偏慢的解析不该被切断重发").toBe(1);
      // 对照：真是短输出的（agent 决策那种）照旧快速重发
      次 = 0;
      expect(await chatJSON("短的", { maxTokens: 500, timeoutMs: 120_000 })).toEqual({ ok: 1 });
      // 前两次照短输出那档快等（30ms）都被掐，第三次给剩下的全部时间，等到了（2026-10-06 起超时最多重发两次）
      expect(次).toBe(3);
    } finally {
      Object.assign(首字等待毫秒, 原);
      收拾();
    }
  });

  it("② 重发那次也等不到：说「AI 响应超时，请稍后重试」，不提重发、不摆英文", async () => {
    const { chatJSON } = await import("@/lib/llm");
    接上();
    let 次 = 0;
    vi.stubGlobal("fetch", async () => {
      次++;
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    try {
      const e = await chatJSON("x", { maxTokens: 500, timeoutMs: 60_000 }).catch((x: Error) => x);
      expect(次).toBe(3);
      expect((e as Error).message).toBe("AI 响应超时，请稍后重试");
    } finally {
      收拾();
    }
  });
});
