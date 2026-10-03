"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 6 位验证码：六个格子，数字一格一格滚进来，光标从一格滑到下一格。
 * 思路学的是 rareui.com 的 OTP Input，代码自己写的——它的许可证不许再分发组件本身（含移植版），
 * 我们的仓库是公开的，抄进来就是再分发。
 *
 * **真正接键盘的是一个透明的 input**，格子只是画出来的样子。这样粘贴、系统自动填的
 * 「邮件里的验证码」（autocomplete=one-time-code）、输入法、退格都是浏览器自己的行为，
 * 不用一格一个 input 再去拼焦点——那种写法粘贴一串会只进第一格。
 *
 * 填满 6 位就调 onDone，由调用方去校验；校验失败时把 错 加一，格子横抖一下并清空。
 */
export default function OtpInput({
  长度 = 6,
  onDone,
  错 = 0,
  禁用 = false,
  自动聚焦 = true,
}: {
  长度?: number;
  onDone: (code: string) => void;
  /** 每加一次就抖一下、清空重填 */
  错?: number;
  禁用?: boolean;
  自动聚焦?: boolean;
}) {
  const [值, set值] = useState("");
  const [聚焦, set聚焦] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const 上次错 = useRef(错);

  useEffect(() => {
    if (错 === 上次错.current) return;
    上次错.current = 错;
    set值("");
    ref.current?.focus();
  }, [错]);

  useEffect(() => {
    if (自动聚焦) ref.current?.focus();
  }, [自动聚焦]);

  const 当前 = Math.min(值.length, 长度 - 1);
  return (
    <div
      className={`otp${错 ? " otp-err" : ""}`}
      key={错}
      onClick={() => ref.current?.focus()}
      role="group"
      aria-label={`${长度} 位验证码`}
      style={{ "--n": 长度, "--i": 当前 } as React.CSSProperties}
    >
      {Array.from({ length: 长度 }, (_, i) => (
        <div key={i} className={`otp-cell${聚焦 && i === 当前 && 值.length < 长度 ? " on" : ""}`} aria-hidden="true">
          {值[i] ? <span key={值[i] + i}>{值[i]}</span> : null}
        </div>
      ))}
      {/* 只有一根光标，按 --i 算位置：换格时是滑过去的，不是这格灭了那格亮 */}
      {聚焦 && 值.length < 长度 && <i className="otp-caret" aria-hidden="true" />}
      <input
        ref={ref}
        className="otp-real"
        value={值}
        disabled={禁用}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="验证码"
        maxLength={长度}
        onFocus={() => set聚焦(true)}
        onBlur={() => set聚焦(false)}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 长度);
          set值(v);
          if (v.length === 长度) onDone(v);
        }}
      />
    </div>
  );
}
