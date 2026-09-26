"use client";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientKey = () => /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const serverKey = () => "⌘";

export function useModifierKey() {
  return useSyncExternalStore(subscribe, clientKey, serverKey);
}

export default function Shortcut({ children }: { children: string }) {
  const key = useModifierKey();
  return children.replaceAll("⌘", key);
}
