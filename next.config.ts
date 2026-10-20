import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 扫名片的识别运行库（public/ocr/v1，scripts/build-ocr.mjs 从 node_modules 打出来，不进仓库）。
 * 放在这里而不是 package.json 的 build：next dev / next build 有好几处直接调（e2e、桌面打包、Dockerfile），
 * 哪一处起服务都先补上；已经有了就不动（认 manifest.json：2026-10-20 起才有，老副本里的旧产物会重打一遍）
 */
if (!existsSync(path.join(process.cwd(), "public/ocr/v1/manifest.json"))) {
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts/build-ocr.mjs")], { stdio: "inherit" });
}

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
 * 手机伴侣 /m 要扫名片：相机放开给自己（不给嵌进来的别家页面），话筒、定位照旧关着。
 * 2026-10-20 客户反馈扫名片「点了没反应」，查到 /m 也带着上面那条 camera=()。
 * 拍照走的是 <input type=file capture>，规范上不归 Permissions-Policy 管，但国产浏览器 / 微信内核各有各的做法，
 * 能放开的先放开。只放 /m 这一页（及其下的路径）：权限策略跟着页面走，页面里调的接口、静态文件不用带
 */
const 手机伴侣权限 = "camera=(self), microphone=(), geolocation=()";

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
  // Prisma 生成的客户端里有动态路径，Turbopack 会把整个项目追进 standalone（含 public/）；Dockerfile 另外再拷一遍 public，
  // 扫名片的 115 MB 识别文件就会在镜像里出现两份。public/ocr 不追，只走 COPY public 那一份
  outputFileTracingExcludes: { "*": ["public/ocr/**"] },

  /*
    只给 e2e 用（playwright.feedback-chain.config.ts）：同一份代码里同时起「云端」和「桌面端本地服务」两个 next dev。
    Next 16 一个构建目录只许一个 dev（<distDir>/dev/lock），所以云端那个换个目录；
    tsconfig 也换成一个 extends 主配置的，免得 next dev 往 tsconfig.json 的 include 里加那个目录。不设就是默认
  */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: process.env.NEXT_TSCONFIG_PATH ? { tsconfigPath: process.env.NEXT_TSCONFIG_PATH } : undefined,

  assetPrefix: 静态资源前缀,

  // 不报框架名——对外少说一句是一句
  poweredByHeader: false,

  /**
   * 扫名片识别文件不让 Next 当 public 文件现压 gzip（不带长度、香港到伦敦约 90 KB/s，2026-10-20），
   * 在找 public 文件之前改写到 app/ocr-files，直接给预先压好的 .br / .gz
   */
  async rewrites() {
    return { beforeFiles: [{ source: "/ocr/:path*", destination: "/ocr-files/:path*" }], afterFiles: [], fallback: [] };
  },

  async headers() {
    return [
      { source: "/:path*", headers: 安全头 },
      // 同一个头后面的覆盖前面的（Next 文档：同名头以后匹配的那条为准）；/m/:path* 也匹配 /m 本身
      { source: "/m/:path*", headers: [{ key: "Permissions-Policy", value: 手机伴侣权限 }] },
      // 扫名片的模型和运行库的缓存头由 app/ocr-files 自己给（一年不变；manifest.json 每次问一下）
    ];
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
