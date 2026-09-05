"use client";

/**
 * 业务配置的客户端一侧：布局在服务端读一次，通过 Context 发给所有客户端组件。
 * 组件里用 `const b = useBusiness()`，然后 `b.customer`（学员/客户）、`b.fields.school`……
 * 没被 Provider 包住时（如单测渲染）回落到默认值，不会因为缺上下文而崩。
 */
import { createContext, useContext } from "react";
import { DEFAULT_BUSINESS, type BusinessConfig } from "./business-config";

const Ctx = createContext<BusinessConfig>(DEFAULT_BUSINESS);

export function BusinessProvider({ value, children }: { value: BusinessConfig; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBusiness(): BusinessConfig {
  return useContext(Ctx);
}
