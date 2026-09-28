"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 发验证码之后的倒计时：left 是还剩几秒，开始() 从头数。注册和找回密码两处共用。
 * 离开页面时把定时器清掉（原来两处各写一份，都没清）。
 */
export function useCountdown(秒: number) {
  const [left, setLeft] = useState(0);
  const 计时 = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(计时.current), []);
  const 开始 = () => {
    clearInterval(计时.current);
    setLeft(秒);
    计时.current = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) clearInterval(计时.current);
        return n - 1;
      });
    }, 1000);
  };
  return [left, 开始] as const;
}
