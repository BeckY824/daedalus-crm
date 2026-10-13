/** 导出文件名：可读、带日期，不用哈希 */
export const 冲突导出文件名 = (d: Date) => `同步权限冲突-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
