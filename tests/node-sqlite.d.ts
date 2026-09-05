/**
 * `node:sqlite` 是 Node 22 的实验特性，@types/node@20 里还没有它的类型。
 * 项目运行在 Node 22（见 Dockerfile 的 node:22-slim），运行时是有的，
 * 只是类型缺失。这里给出用到的最小声明，不升 @types/node——
 * 升级会牵动整个类型基线，为一个测试文件不值得。
 *
 * 生产代码不直接用它：应用走 Prisma，只有 entrypoint 和备份脚本用
 * `node -e` 调它（不参与类型检查）。
 */
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
    close(): void;
  }
}
