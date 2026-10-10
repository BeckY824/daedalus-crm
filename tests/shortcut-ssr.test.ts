import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import Shortcut, { ShortcutProvider } from "@/components/Shortcut";

it.each([[false, "Ctrl+K"], [true, "⌘K"]] as const)("E1 mac=%s 首屏尚未水合时键位已与系统一致", (mac, label) => {
  const view = createElement(ShortcutProvider, { mac }, createElement(Shortcut, null, "⌘K"));
  expect(renderToStaticMarkup(view)).toBe(label);
});
