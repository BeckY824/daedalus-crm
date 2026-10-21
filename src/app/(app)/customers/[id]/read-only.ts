import { createContext } from "react";

/**
 * 这一页的客户只能看（团队开了「同事之间互相看得到客户」，这位是同事的、不在公海，2026-10-20）。
 * 档案格子、状态章读它：只显示、不给点。按钮由 RecordView 自己按 只读 收起
 */
export const 只读上下文 = createContext(false);
