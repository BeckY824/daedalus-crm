/**
 * /api/health 是唯一一个不需要凭证、不看租户的接口。钉两件事：
 * 回的版本号就是 package.json 里的（发版后拿它确认镜像真换了），
 * 以及除了 ok 和 version 什么都不回——多一个字段就是多一条信息泄露。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("/api/health", () => {
  it("200，只回 ok 和版本号，不缓存", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    const 版本 = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")).version;
    expect(body).toEqual({ ok: true, version: 版本 });
  });
});
