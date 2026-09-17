"use client";

import { useRef } from "react";
import { ArrowUpOutlined } from "@ant-design/icons";

/**
 * 问一句的那个输入框。**首页和「数据」页用的是同一个。**
 *
 * 原来两处各写一个：首页是带命令、排队、建议卡的对话框，数据页是 antd 的
 * Input.Search。边框、字号、快捷键、占位文案全都不一样——用的人会以为那是两种能力，
 * 而它们问的是同一个后端。
 *
 * 这里只管**框本身**：外形、自适应高度、Enter 发送 / Shift+Enter 换行。
 * ⌘K 不在这儿——它由 components/CommandBar 一个人管：有框的页面把光标放回框里，
 * 没框的页面弹跳转单。两边各写一份的话，迟早在某一页上打架。
 * 上面要不要挂命令单、下面要不要挂提示和建议、发送键点了干什么，
 * 都由用的那一页自己给——两页要答的东西不一样，答案怎么画本来就该各管各的。
 */
export default function AskBox({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  placeholder,
  disabled,
  maxLength = 1000,
  发送,
  上方,
  底部,
  栏左,
  栏右,
  引用,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** 先给这一页自己处理；调了 preventDefault 就不再走默认的 Enter 发送 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
  disabled?: boolean;
  maxLength?: number;
  /** 右边那个键。不给就用默认的发送箭头 */
  发送?: React.ReactNode;
  上方?: React.ReactNode;
  底部?: React.ReactNode;
  /**
   * 框**里面**那一条：左边放动作（加文件），右边放选择（模型），发送键永远在最右。
   * 照 Claude Code / Codex 那个形状——动作和输入在同一个框里，不是散在框外的一行提示。
   * 不给就还是原来那样：一行，提示符 + 输入 + 发送键。
   */
  栏左?: React.ReactNode;
  栏右?: React.ReactNode;
  引用?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const 自己的 = useRef<HTMLTextAreaElement>(null);
  const ta = 引用 ?? 自己的;

  return (
    <>
      {上方}
      <div className={`cli-input${栏左 || 栏右 ? " cli-input-rich" : ""}`}>
        {!(栏左 || 栏右) && <span className="cli-prompt">›</span>}
        <textarea
          ref={ta}
          value={value}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
          }}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {栏左 || 栏右 ? (
          <div className="cli-bar2">
            <div className="cli-bar2-l">{栏左}</div>
            <div className="cli-bar2-r">
              {栏右}
              {发送 ?? (
                <button type="button" className="cli-send" onClick={onSubmit} disabled={!value.trim()} aria-label="问">
                  <ArrowUpOutlined />
                </button>
              )}
            </div>
          </div>
        ) : (
          发送 ?? (
            <button type="button" className="cli-send" onClick={onSubmit} disabled={!value.trim()} aria-label="问">
              <ArrowUpOutlined />
            </button>
          )
        )}
      </div>
      {底部}
    </>
  );
}
