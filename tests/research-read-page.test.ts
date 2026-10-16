/**
 * 背调读网页（lib/research/read-page.ts）。
 *
 * 这是替外面的人去连任意网址，所以大半在钉「什么时候不连」：内网 / 回环 / 链路本地 / CGNAT / 元数据地址、
 * 映射成 IPv6 的这些地址、公网页面跳转到内网、非 80/443 端口、非 http(s)。
 * 再加正向的：只收网页、最多 2 MB、HTML 转出来的是正文。不连外网：网络一律换成假的。
 */
import { describe, it, expect, afterAll } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { 读网页, 读页出错, 是内网地址, 网页转文字, 钉住地址取, 最多字数 } from "@/lib/research/read-page";

const 公网 = async () => [{ address: "93.184.216.34", family: 4 }];
const 页 = (body: string | Uint8Array, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) =>
  new Response(body as BodyInit, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...init.headers } });

describe("哪些地址不能连", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.100.100.200",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    "64:ff9b::a00:1", "2002:a00:1::1", "ff02::1", "2001:db8::1", "不是地址",
  ])("%s 不能连", (ip) => expect(是内网地址(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("%s 可以连", (ip) => {
    expect(是内网地址(ip)).toBe(false);
  });
});

describe("读网页：拒绝", () => {
  const 不该连 = async () => {
    throw new Error("不该发请求");
  };

  it.each([
    ["ftp://example.com/x", "http / https"],
    ["file:///etc/passwd", "http / https"],
    ["http://example.com:8080/", "80 / 443"],
    ["http://user:pw@example.com/", "账号密码"],
    ["http://127.0.0.1/", "内网"],
    ["http://[::1]/", "内网"],
    ["http://[::ffff:127.0.0.1]/", "内网"],
    ["http://169.254.169.254/latest/meta-data/", "内网"],
    ["http://localhost/", "内网"],
    ["不是网址", "格式"],
  ])("%s", async (url, 原因) => {
    const e = await 读网页(url, { fetchImpl: 不该连, resolveImpl: 公网 }).catch((x) => x);
    expect(e).toBeInstanceOf(读页出错);
    expect((e as Error).message).toMatch(/^这个网址读不了：/);
    expect((e as Error).message).toContain(原因);
  });

  it("域名解析出来的地址里**有一个**是内网就不连（A 记录里混一个 127.0.0.1）", async () => {
    const e = await 读网页("https://evil.example/", {
      fetchImpl: 不该连,
      resolveImpl: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
    }).catch((x) => x);
    expect((e as Error).message).toContain("内网");
  });

  it("公网页面跳转到内网地址：拦在跳转那一步", async () => {
    const 请求过: string[] = [];
    const e = await 读网页("https://ok.example/", {
      resolveImpl: async (h) => (h === "inner.example" ? [{ address: "10.0.0.5", family: 4 }] : 公网()),
      fetchImpl: async (u) => {
        请求过.push(u);
        return new Response(null, { status: 302, headers: { location: "http://inner.example/admin" } });
      },
    }).catch((x) => x);
    expect((e as Error).message).toContain("内网");
    expect(请求过).toEqual(["https://ok.example/"]);
  });

  it("跳转到 IP 字面量的元数据地址也拦", async () => {
    const e = await 读网页("https://ok.example/", {
      resolveImpl: 公网,
      fetchImpl: async () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }),
    }).catch((x) => x);
    expect((e as Error).message).toContain("内网");
  });

  it("跳转超过 3 次不跟了", async () => {
    let n = 0;
    const e = await 读网页("https://ok.example/0", {
      resolveImpl: 公网,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: `/${++n}` } }),
    }).catch((x) => x);
    expect((e as Error).message).toContain("跳转次数太多");
    expect(n).toBe(4);
  });

  it("不是网页（PDF、图片）不读", async () => {
    const e = await 读网页("https://ok.example/a.pdf", { resolveImpl: 公网, fetchImpl: async () => 页("%PDF", { type: "application/pdf" }) }).catch((x) => x);
    expect((e as Error).message).toContain("不是网页（application/pdf）");
  });

  it("对方返回 404", async () => {
    const e = await 读网页("https://ok.example/", { resolveImpl: 公网, fetchImpl: async () => 页("nope", { status: 404 }) }).catch((x) => x);
    expect((e as Error).message).toContain("返回 404");
  });

  it("域名解析不到", async () => {
    const e = await 读网页("https://nx.example/", {
      resolveImpl: async () => {
        throw new Error("ENOTFOUND");
      },
      fetchImpl: 不该连,
    }).catch((x) => x);
    expect((e as Error).message).toContain("解析不到");
  });
});

describe("读网页：正文", () => {
  it("跟着公网之间的跳转走，回的是最后那个网址", async () => {
    const r = await 读网页("https://ok.example/old", {
      resolveImpl: 公网,
      fetchImpl: async (u) => (u.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : 页("<title>新页</title><p>你好</p>")),
    });
    expect(r).toEqual({ url: "https://ok.example/new", title: "新页", text: "你好", 截断了: false });
  });

  it("HTML 转正文：去掉脚本、样式、导航、页脚、svg，保留标题，解实体", () => {
    const html = `<!doctype html><html><head><title>Acme &amp; Co</title><style>.x{color:red}</style><script>var s=1</script></head>
      <body><nav><a href="/">首页</a><a href="/p">产品</a></nav>
      <h1>关于我们</h1><p>Acme 成立于 2009 年，&nbsp;主营 LED&#x2F;灯具。</p>
      <svg><text>logo</text></svg><!-- 注释 -->
      <ul><li>进口商</li><li>分销商</li></ul>
      <footer>版权所有</footer></body></html>`;
    const r = 网页转文字(html);
    expect(r.title).toBe("Acme & Co");
    expect(r.text).toBe("关于我们\nAcme 成立于 2009 年， 主营 LED/灯具。\n进口商\n分销商");
  });

  it("纯文本照收；超过 12000 字截断并标出来", async () => {
    const r = await 读网页("https://ok.example/a.txt", { resolveImpl: 公网, fetchImpl: async () => 页("字".repeat(20_000), { type: "text/plain" }) });
    expect(r.text.length).toBe(最多字数);
    expect(r.截断了).toBe(true);
  });

  it("正文最多读 2 MB，多的不读、标截断", async () => {
    const 大 = new TextEncoder().encode("<p>" + "a ".repeat(2 * 1024 * 1024) + "</p>");
    let 取了 = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (取了 >= 大.length) return c.close();
        const 块 = 大.subarray(取了, 取了 + 65536);
        取了 += 块.length;
        c.enqueue(块);
      },
    });
    const r = await 读网页("https://ok.example/", { resolveImpl: 公网, fetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }) });
    expect(r.截断了).toBe(true);
    expect(取了).toBeLessThan(大.length);
  });

  it("GBK 的老网站按 meta charset 解码", async () => {
    // 「你好」的 GBK 编码
    const gbk = new Uint8Array([...new TextEncoder().encode('<meta charset="gbk"><p>'), 0xc4, 0xe3, 0xba, 0xc3, ...new TextEncoder().encode("</p>")]);
    const r = await 读网页("https://ok.example/", { resolveImpl: 公网, fetchImpl: async () => 页(gbk, { type: "text/html" }) });
    expect(r.text).toBe("你好");
  });

  it("空页面（全是脚本画出来的）说清楚", async () => {
    const e = await 读网页("https://ok.example/", { resolveImpl: 公网, fetchImpl: async () => 页("<script>render()</script>") }).catch((x) => x);
    expect((e as Error).message).toContain("没有文字内容");
  });
});

describe("默认的取页：连接钉在查过的地址上", () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/gz") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(zlib.gzipSync("<p>压缩过的</p>"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<p>host=${req.headers.host}</p>`);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("域名不再自己解析，直接连钉住的地址；Host 头照旧是原域名；gzip 解开", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const 取 = 钉住地址取({ address: "127.0.0.1", family: 4 });
    const init = { signal: AbortSignal.timeout(5000), headers: {}, redirect: "manual" as const };
    // nowhere.invalid 永远解析不到：能连上只说明用的是钉住的地址
    const a = await 取(`http://nowhere.invalid:${port}/`, init);
    expect(await a.text()).toBe(`<p>host=nowhere.invalid:${port}</p>`);
    const b = await 取(`http://nowhere.invalid:${port}/gz`, init);
    expect(await b.text()).toBe("<p>压缩过的</p>");
  });
});
