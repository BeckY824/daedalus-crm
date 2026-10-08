"use client";

/**
 * 业务配置的客户端一侧：布局在服务端读一次，通过 Context 发给所有客户端组件。
 * 组件里用 `const b = useBusiness()`，然后 `b.customer`（学员/客户）、`b.fields.school`……
 * 没被 Provider 包住时（如单测渲染）回落到默认值，不会因为缺上下文而崩。
 */
import { businessDayjs, configureBrowserBusinessTimeZone } from "./business-clock";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect } from "react";
import { DEFAULT_BUSINESS, type BusinessConfig } from "./business-config";

const Ctx = createContext<BusinessConfig>(DEFAULT_BUSINESS);

const TimeZoneCtx = createContext<"Asia/Shanghai" | null>(null);
export function BusinessProvider({ value, children, timeZone = null }: { value: BusinessConfig; children: React.ReactNode; timeZone?: "Asia/Shanghai" | null }) {
  configureBrowserBusinessTimeZone(timeZone);
  const router = useRouter();
  useEffect(() => {
    let day = businessDayjs().format("YYYY-MM-DD");
    const check = () => {
      const next = businessDayjs().format("YYYY-MM-DD");
      if (next !== day) { day = next; router.refresh(); }
    };
    const timer = setInterval(check, 30_000);
    document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [router, timeZone]);
  return <TimeZoneCtx.Provider value={timeZone}><Ctx.Provider value={value}>{children}</Ctx.Provider></TimeZoneCtx.Provider>;
}

export function useBusiness(): BusinessConfig {
  return useContext(Ctx);
}

export function useBusinessTimeZone(): "Asia/Shanghai" | null { return useContext(TimeZoneCtx); }
