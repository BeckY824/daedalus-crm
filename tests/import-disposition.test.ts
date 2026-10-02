/**
 * 导入第 4 步改「重复行」处置时，补空 / 跳过当场重算（import-steps 的 按处置，2026-10-02 排查）。
 * 原来预览只在第 2 步按默认「跳过」算一次：表里的人全在库里、改选「只补空」后界面写「补空 0」，「开始导入」一直是灰的。
 */
import { describe, it, expect } from "vitest";
import { 按处置 } from "@/app/(app)/customers/import-steps";
import type { 预览 } from "@/app/(app)/customers/import-actions";

const 看: 预览 = { 新建: 0, 补空: 0, 跳过: 5, 已在库里: 4, 说不清: 1, 进不了: 0, 合掉几行: 0, 待复核: [], 挡下: [], 没对上的列名: [] } as unknown as 预览;

describe("按处置", () => {
  it("改成只补空：认得出的 4 位都算补空，认不清的 1 位照样跳过", () => {
    expect(按处置(看, "补空")).toMatchObject({ 补空: 4, 跳过: 1 });
  });
  it("跳过：补空 0，跳过 = 认得出的 + 认不清的", () => {
    expect(按处置(看, "跳过")).toMatchObject({ 补空: 0, 跳过: 5 });
  });
});
