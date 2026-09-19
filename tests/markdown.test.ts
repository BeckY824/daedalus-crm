/**
 * 回答的渲染。**换到 DeepSeek 之后它非常爱画表**——问一个渠道的电话，
 * 它先画一张六列的表（只有一行）。提示词能压住一部分，压不住的那部分
 * 不能让人看见一排竖线和 `|---|---|`，所以渲染器得认表格。
 *
 * 不引 jsdom：`renderToStaticMarkup` + `createElement`，在 .ts 里就跑得起来。
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "@/components/Markdown";

const 渲 = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("表格", () => {
  const 表 = ["| 渠道 | 负责人 | 状态 |", "|---|---|---|", "| 明杰哥 | becky | 在用 |", "| 老周 | 张三 | 已停用 |"].join("\n");

  it("画成真表格，不是一堆竖线", () => {
    const h = 渲(表);
    expect(h).toContain("<table");
    // 格子里套着 Inline 的 span（加粗和引用要在里面切），所以只断言「这一格里有这几个字」
    expect(h).toMatch(/<th>.*渠道.*<\/th>/);
    expect(h).toMatch(/<td>.*明杰哥.*<\/td>/);
    // 分隔线不许漏成一行内容
    expect(h).not.toContain("---");
    expect(h).not.toContain("|");
  });

  it("模型漏写分隔线时也照样渲染——那是常事，不能退化成竖线", () => {
    const h = 渲(["| 明杰哥 | becky |", "| 老周 | 张三 |"].join("\n"));
    expect(h).toContain("<table");
    expect(h).not.toContain("|");
    // 没有分隔线就没有表头，全部当正文行
    expect(h).not.toContain("<thead");
  });

  it("表格外面套一层能横滚的壳：窄面板里不把整栏撑开", () => {
    expect(渲(表)).toContain('class="md-tw"');
  });

  it("表格前后的正文照常渲染", () => {
    const h = 渲(`就这一个渠道：\n${表}\n要不要再建一个？`);
    expect(h).toContain("就这一个渠道：");
    expect(h).toContain("要不要再建一个？");
    expect(h).toContain("<table");
  });

  it("格子里的加粗照样生效", () => {
    expect(渲("| a |\n|---|\n| **粗** |")).toContain("<strong>");
  });
});

describe("行内代码", () => {
  it("`13900008888` 渲染成 code，不是三个反引号", () => {
    const h = 渲("电话是 `13900008888`。");
    expect(h).toContain('class="md-code"');
    expect(h).toContain("13900008888");
    expect(h).not.toContain("`");
  });
});

describe("原来就有的那几样没被表格这一段带坏", () => {
  it("列表、标题、加粗照旧", () => {
    const h = 渲("## 标题\n- 一\n- 二\n**粗**");
    expect(h).toContain('class="md-h"');
    expect(h).toContain("<ul");
    expect(h).toContain("<li>");
    expect(h).toContain("<strong>");
  });

  it("分隔线仍然不占位", () => {
    expect(渲("上\n---\n下")).not.toContain("<hr");
  });
});
