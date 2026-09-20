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
 * 静态资源（`/_next/static/*`）换一个域名发。**只在构建镜像时生效**，运行时设它没有用。
 *
 * 2026-09-20 花了一下午确认这件事：我们托管的那份跑在香港、用户在国内，一个登录页
 * 压缩后 758 KB 里有 729 KB 是 JS/CSS，把它们指到国内节点能省掉四成时间。
 * 但 `output: "standalone"` 会把这份配置**烤进 server.js**，所以当时试着在容器启动时
 * 改那一处——结果是：服务端发出的 HTML 用了新地址，而客户端那半仍按原地址工作，
 * 两边对不上，React 水合失败。**不报错、结构都在、入场动画停在透明，就是一片纯白。**
 * 开→白、关→好，两台设备来回验了四次。那段启动时改写已经删掉了。
 *
 * 所以要用它，只能**构建时**传 `ASSET_PREFIX=...`——而那意味着托管版得单独出一个镜像：
 * 同一个镜像还要给自部署的人（凭什么去我们的服务器取 JS）和桌面端（断网就白屏）用。
 * 我们暂时不做，等国内节点备案通过，整个应用搬过去，这件事自然就不存在了。
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
