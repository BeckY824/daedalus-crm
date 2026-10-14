import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require_ = createRequire(import.meta.url);
const { 检查 } = require_("../desktop/updater.js");
const { 下载文件, 校验sha256 } = require_("../desktop/install.js");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-update-safety-")); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const sha = "a".repeat(64);
const gh = { tag_name: "v0.47.0", assets: [{ name: "Daedalus-CRM-0.47.0-x64-setup.exe", browser_download_url: "https://example.com/setup.exe", digest: `sha256:${sha}` }] };
const network = (feed: unknown) => vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("api.github.com") ? gh : feed })));
it.each(["http://insecure.example/app.dmg", "file:///tmp/app.dmg", "javascript:alert(1)", "https://user:password@example.com/app.dmg"])("R-004 不安全主/差量/备用/下载页地址拒绝：%s", async (url) => {
  network({ version: "0.47.0", url, dmg: url, zip: url, manifest: url, sha256: sha, manifest_sha256: sha, 备用: { dmg: url } });
  const result = await 检查({ 当前版本: "0.46.15" });
  expect(result).toMatchObject({ dmg: null, zip: null, manifest: null, 备用: null, 地址: "https://ai-daedalus.com/download.html" });
});
it.each(["sha256:abcd", "not-a-hash", "a".repeat(63), "a".repeat(65)])("R-004 无效哈希不能成为自动更新凭据：%s", async (hash) => {
  network({ version: "0.47.0", dmg: "https://example.com/a.dmg", sha256: hash, manifest_sha256: hash });
  expect(await 检查({ 当前版本: "0.46.15" })).toMatchObject({ sha256: null, 清单哈希: null });
});
it("R-004 HTTPS重定向到HTTP时，在发出不安全请求前拒绝", async () => {
  const bytes = Buffer.from("QA installer"); const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { Location: "http://insecure.example/app.dmg" } });
    return new Response(bytes); // 旧实现自动follow，不会在这一步检查降级。
  });
  const target = path.join(root, "app.dmg");
  await expect(下载文件({ url: "https://example.com/app.dmg", 目标: target, sha256: digest, fetch: fetcher, 重试: 0 })).rejects.toThrow(/HTTPS|安全/);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fs.existsSync(target)).toBe(false);
});
it("R-004 下载直调HTTP也要拒绝，不创建文件或发请求", async () => {
  const fetcher = vi.fn(async () => new Response("QA"));
  await expect(下载文件({ url: "http://insecure.example/app.dmg", 目标: path.join(root, "app.dmg"), sha256: sha, fetch: fetcher, 重试: 0 })).rejects.toThrow(/HTTPS|安全/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("R-004 校验器提前拒绝无效/空SHA", async () => {
  for (const hash of [null, "", "abcd"]) await expect(校验sha256(path.join(root, "missing"), hash)).rejects.toThrow(/sha256|SHA/);
});
it("R-005 200错误JSON不是有效feed，可从GitHub恢复", async () => {
  network({ message: "Not Found" });
  expect(await 检查({ 当前版本: "0.46.15", platform: "win32", arch: "x64" })).toMatchObject({ 版本: "v0.47.0", exe: "https://example.com/setup.exe" });
});
it("R-005 有效feed人工撤下Windows仍要按住，不能GitHub越闸", async () => {
  network({ version: "0.47.0", platforms: {} });
  expect(await 检查({ 当前版本: "0.46.15", platform: "win32", arch: "x64" })).toBeNull();
});
it("R-004 明确开启本机HTTP也只能访问回环，不能放开外网HTTP", async () => {
  const { 安全获取 } = require_("../desktop/update-security.js");
  const f = vi.fn(async () => new Response("QA"));
  await expect(安全获取("http://127.0.0.1:1234/test", {}, f)).rejects.toThrow(/HTTPS/); expect(f).not.toHaveBeenCalled();
  vi.stubEnv("CRM_UPDATE_ALLOW_LOCAL_HTTP", "1");
  expect((await 安全获取("http://127.0.0.1:1234/test", {}, f)).ok).toBe(true);
  await expect(安全获取("http://localhost.evil.example/test", {}, f)).rejects.toThrow(/HTTPS/);
  expect(f).toHaveBeenCalledTimes(1);
});
it("R-004 安全HTTPS重定向保留Range，逐跳获取成功", async () => {
  const { 安全获取 } = require_("../desktop/update-security.js");
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual"); expect(init?.headers).toEqual({ Range: "bytes=0-3" });
    return url === "https://example.com/app" ? new Response(null, { status: 302, headers: { Location: "/cdn/app" } }) : new Response("QA");
  });
  expect(await (await 安全获取("https://example.com/app", { headers: { Range: "bytes=0-3" } }, f)).text()).toBe("QA");
  expect(f.mock.calls.map((call) => call[0])).toEqual(["https://example.com/app", "https://example.com/cdn/app"]);
});
it("R-004 镜像坏哈希不成为正式文件，备用正确包可恢复", async () => {
  const content = Buffer.from("QA valid installer"); const hash = crypto.createHash("sha256").update(content).digest("hex");
  const f = vi.fn(async (url: string) => new Response(url.includes("mirror") ? "QA corrupt" : content));
  const target = path.join(root, "app.dmg");
  await 下载文件({ url: "https://mirror.example/app", 备用: "https://fallback.example/app", 目标: target, sha256: hash, fetch: f, 重试: 0 });
  expect(fs.readFileSync(target)).toEqual(content); expect(f).toHaveBeenCalledTimes(2); expect(fs.existsSync(`${target}.part`)).toBe(false);
});
it("新增桌面依赖也必须进安装包，避免源码可跑但出包崩溃", () => {
  const dir = path.resolve(__dirname, "../desktop");
  const files: string[] = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).build.files;
  for (const name of files.filter((name) => name.endsWith(".js"))) {
    for (const match of fs.readFileSync(path.join(dir, name), "utf8").matchAll(/require\(["']\.\/([^"']+)["']\)/g)) {
      expect(files, `${name}依赖${match[1]}却没有打包`).toContain(`${match[1].replace(/\.js$/, "")}.js`);
    }
  }
});
