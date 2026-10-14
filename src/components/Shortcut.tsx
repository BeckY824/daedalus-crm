"use client";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};
const clientKey = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
// 首屏不能一律画 Mac 键位：JavaScript 尚未水合时 Windows 也会看到它。
const ServerModifier = createContext("Ctrl+");
export function ShortcutProvider({ mac, children }: { mac: boolean; children?: ReactNode }) {
  return <ServerModifier.Provider value={mac ? "⌘" : "Ctrl+"}>{children}</ServerModifier.Provider>;
}

export function useModifierKey() {
  const serverKey = useContext(ServerModifier);
  return useSyncExternalStore(subscribe, clientKey, () => serverKey);
}

export default function Shortcut({ children }: { children: string }) {
  const key = useModifierKey();
  return children.replaceAll("⌘", key);
}
