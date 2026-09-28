/**
 * AI 解析填表只填人没动过的格子（lib/fill-untouched.ts，交互审查 M6）。
 * 通则：凡是系统帮你填的字段，一旦人动过手，就不能再被自动逻辑改回去。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { 只填没动过的, 跳过说明 } from "@/lib/fill-untouched";

const 名 = { type: "类型", title: "标题", content: "内容", contactId: "联系人" };

describe("只填没动过的", () => {
  it("动过的格子留着，没动过的照填", () => {
    const r = 只填没动过的({ type: "PHONE", title: "AI 起的标题", content: "AI 整理的内容" }, (k) => k === "title");
    expect(r.填).toEqual({ type: "PHONE", content: "AI 整理的内容" });
    expect(r.跳过).toEqual(["title"]);
    expect(跳过说明(r.跳过, 名)).toBe("标题你改过，没动");
  });

  it("几格都改过：一句话列全", () => {
    const r = 只填没动过的({ type: "MEETING", title: "t", content: "c" }, (k) => k !== "type");
    expect(跳过说明(r.跳过, 名)).toBe("标题、内容你改过，没动");
  });

  it("AI 这一格本来就是空的：人改过也不必说「没动」", () => {
    const r = 只填没动过的({ title: undefined, contactId: undefined, content: "" }, () => true);
    expect(r.填).toEqual({});
    expect(r.跳过).toEqual([]);
    expect(跳过说明(r.跳过, 名)).toBeNull();
  });

  it("都没动过：和原来一样整张填上（没动过的空值也照填，好把上一轮 AI 填的换掉）", () => {
    const r = 只填没动过的({ type: "PHONE", contactId: undefined }, () => false);
    expect(r.填).toEqual({ type: "PHONE", contactId: undefined });
    expect("contactId" in r.填).toBe(true);
  });

  it("记录页的 AI 解析走的就是它，按 antd 的 isFieldTouched 判", () => {
    const s = fs.readFileSync(path.resolve(__dirname, "../src/app/(app)/customers/[id]/FollowUpForm.tsx"), "utf8");
    expect(s).toMatch(/只填没动过的\(/);
    expect(s).toMatch(/form\.isFieldTouched\(name\)/);
    expect(s).toMatch(/form\.setFieldsValue\(填\)/);
  });
});
