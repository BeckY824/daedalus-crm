"use client";
/**
 * 左栏右边那条能拖的缝。实现搬到了 WidthHandle——首页的对话列表和右边的 AI 面板
 * 要的是同一件事，三份一模一样的拖拽代码没有道理。这里只留规格和调用处的名字。
 */
import WidthHandle, { 左栏把手 } from "./WidthHandle";

export default function RailResizer() {
  return <WidthHandle 规格={左栏把手} />;
}
