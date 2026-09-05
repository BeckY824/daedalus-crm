import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 容器部署：产出自带最小 node_modules 的独立 server.js
  output: "standalone",

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
