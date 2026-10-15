"use client";

import { useEffect } from "react";

/** 只在正式构建里注册（开发时它会把热更新的文件缓存住）。注册不上不影响用，只是断网打不开 */
export default function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(() => undefined);
  }, []);
  return null;
}
