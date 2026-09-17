"use client";

import { useRef, useState } from "react";
import { PaperClipOutlined, CloseOutlined } from "@ant-design/icons";
import { App } from "antd";

/**
 * 问一句的时候带上一个文件。
 *
 * **文件不离开这台机器，除了被发给你选的那个模型。** 在浏览器里读成文本，
 * 跟着这一问发出去，不落库、不写磁盘、不进操作日志——所以「我的数据在我自己机器上」
 * 这句话在带文件提问时仍然成立。关掉这一问，内容就没了。
 *
 * 只收**文本**：txt / md / csv / tsv / json / log。Excel 和 PDF 不收——
 * 它们要在客户端拖一个解析库进来，而解析出来的东西未必是人以为的那份
 * （合并单元格、多工作表、扫描件），不如让人自己另存成 csv，至少他知道发出去的是什么。
 */
export type 附件 = { name: string; text: string; size: number };

/** 单个文件的文本上限。再大就不是「带一份名单问一句」，而是拿模型当数据库用 */
const 单文件上限 = 100 * 1024;
const 可读后缀 = [".txt", ".md", ".csv", ".tsv", ".json", ".log"];

export function 文件字数(f: 附件[]): number {
  return f.reduce((s, x) => s + x.text.length, 0);
}

export default function AskFiles({
  files,
  onChange,
  disabled,
}: {
  files: 附件[];
  onChange: (f: 附件[]) => void;
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const input = useRef<HTMLInputElement>(null);
  const [读取中, set读取中] = useState(false);

  async function 选好了(list: FileList | null) {
    if (!list?.length) return;
    const f = list[0];
    const 后缀 = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!可读后缀.includes(后缀)) {
      message.error(`只认文本文件（${可读后缀.join(" ")}）。Excel 请另存成 csv 再来`);
      return;
    }
    if (f.size > 单文件上限) {
      message.error(`文件太大（${Math.round(f.size / 1024)} KB），上限 ${单文件上限 / 1024} KB`);
      return;
    }
    set读取中(true);
    try {
      const text = await f.text();
      // 同名的换掉，不叠加：重选一次多半是因为选错了
      onChange([...files.filter((x) => x.name !== f.name), { name: f.name, text, size: f.size }]);
    } catch {
      message.error("这个文件读不出来");
    } finally {
      set读取中(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={可读后缀.join(",")}
        style={{ display: "none" }}
        onChange={(e) => 选好了(e.target.files)}
      />
      <button
        type="button"
        className="cli-tool"
        disabled={disabled || 读取中}
        onClick={() => input.current?.click()}
        title="带一个文本文件问（txt / md / csv / tsv / json / log）。内容只随这一问发给模型，不会存下来"
        aria-label="添加文件"
      >
        <PaperClipOutlined />
      </button>
      {files.map((f) => (
        <span key={f.name} className="cli-file" title={`${f.name} · ${Math.round(f.size / 1024) || 1} KB · 只随这一问发出，不会存下来`}>
          <span className="cli-file-n">{f.name}</span>
          <button type="button" aria-label={`移除 ${f.name}`} onClick={() => onChange(files.filter((x) => x.name !== f.name))}>
            <CloseOutlined />
          </button>
        </span>
      ))}
    </>
  );
}
