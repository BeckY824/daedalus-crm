import type { NextConfig } from "next";

/**
 * 安全响应头放在这里而不是反代里：托管版前面是 Caddy，自部署的人多半直接裸露 3000 端口，
 * 写进 Next 两边都吃到，而且能单测（tests/security-headers.test.ts）。
 *
 * 没加 CSP——Next 的内联脚本要走 nonce，改起来是另一件事。
 * HSTS 只有走 HTTPS 时浏览器才认，纯 HTTP 的自部署会被忽略，放着无害；
 * 不带 preload：那是提交给浏览器厂商的名单，撤不回来。
 */
const 安全头 = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * 静态资源（`/_next/static/*`）换一个域名发。**默认关着**，只有设了 ASSET_PREFIX 才开。
 *
 * 为什么要有它：我们托管的那份跑在香港，而用户在国内。一个登录页压缩后 758 KB，
 * 其中 **729 KB 是那 34 个 JS/CSS**——跨境线路实测 200-700 KB/s 且剧烈抖动，
 * 这些字节就是「点开很慢」的全部来源。把它们指到国内节点（那儿做了缓存反代），
 * 第一个人回源一次，后面所有人都走国内。
 *
 * **必须是环境变量，不能写死**：同一个镜像还要给自部署的人和桌面端用。
 * 写死的话，自部署的人打开自己的 CRM 会去我们的服务器上取 JS（他们凭什么信任我们），
 * 而桌面端断网就直接白屏——它整个服务是跑在用户自己机器上的。
 *
 * 这些文件名自带内容 hash、响应头是 `max-age=31536000, immutable`（Next 自己设的），
 * 所以换版本不用清缓存，旧文件也不会被新文件顶掉。
 */
const 静态资源前缀 = process.env.ASSET_PREFIX?.trim() || undefined;

const nextConfig: NextConfig = {
  // 容器部署：产出自带最小 node_modules 的独立 server.js
  output: "standalone",

  assetPrefix: 静态资源前缀,

  // 不报框架名——对外少说一句是一句
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: 安全头 }];
  },

  experimental: {
    /**
     * 客户端路由缓存。默认动态页面为 0，意味着每次切换（包括切回刚看过的页面）
     * 都要重新请求服务器；跨境链路上这一次往返就是肉眼可见的卡顿。
     * 设为 60 秒后，一分钟内重复访问同一页面直接走本地缓存，切换是瞬时的。
     * 代价是数据最多滞后 60 秒——对 CRM 这种低频变更场景可以接受，
     * 且新建/修改后我们本来就会主动 router.refresh()。
     */
    staleTimes: {
      dynamic: 60,
      static: 300,
    },
  },
};

export default nextConfig;
