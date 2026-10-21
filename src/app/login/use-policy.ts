"use client";
import { useEffect, useState } from "react";
import { 桌面端策略 } from "./actions";
import type { 云端策略 } from "@/lib/desktop/cloud";

/**
 * 登录页、找回密码页手上的「云端开着哪几条路」（2026-10-21）。
 * 先用服务端带过来的那份（这次启动问到过的，或者都开着）把页面画出来，再在后台问一次云端，问到就换。
 * 问不到、问的时候出错都不动：页面照旧能用，「继续」那一步云端还会再答一次。
 */
export function useCloudPolicy(初始: 云端策略): 云端策略 {
  const [p, setP] = useState(初始);
  useEffect(() => {
    let 走了 = false;
    桌面端策略()
      .then((r) => {
        if (r && !走了) setP(r);
      })
      .catch(() => {});
    return () => {
      走了 = true;
    };
  }, []);
  return p;
}
