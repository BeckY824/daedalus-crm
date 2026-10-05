/**
 * SQLite 的 Prisma 连接串一律只开 1 个连接（2026-10-05）。
 *
 * 连接池多开几个连接对 SQLite 没好处——写本来就只能一个一个来——反而会在 Linux 上卡死：
 * 一个交互式事务（查完再写、签约落库、同步回放……）开着时，别的请求在池里另外几个连接上写库，
 * 在 SQLite 层面撞锁等待，事务自己的下一句也推不动，最后整批「Socket timeout」。
 * Mac 上碰巧不发作，Linux（托管版的服务器、CI）上 5 个人同时建客户就卡住（tests/stress.test.ts，
 * main 上第一次跑 CI 时撞到，Docker 里 Linux 2 核复现、二分到 J-104 引入交互式事务那一提交）。
 * 1 个连接时所有读写在 Prisma 这一层排队，SQLite 层面不再有锁竞争。
 *
 * 代价：事务里面不能再用外面的全局客户端（会等自己）。事务里只用 tx，本来就是规矩（lib/check-then-write）。
 * 已经写了 connection_limit 的连接串原样用（测试里需要时可以覆盖）。
 */
export function 单连接(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:")) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}
