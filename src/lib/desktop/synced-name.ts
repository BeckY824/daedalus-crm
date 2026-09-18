/**
 * 「上一次从云端同步下来的名字」这条记账的 key。
 *
 * 两个地方按它判断「这个名字是我们写的，还是人自己写的」：
 *   app/login/actions.ts  —— 桌面端登录时
 *   desktop/server-entry.js —— 每次启动时（那边是裸 SQL，key 抄的是这里的值）
 *
 * 单独一个文件是为了让那两处引用同一个常量；server-entry 抄不了 TS，
 * 但抄错了会被 tests/desktop-shell.test.ts 当场拦住。
 */
export const 同步名字键 = "desktop.syncedName";
