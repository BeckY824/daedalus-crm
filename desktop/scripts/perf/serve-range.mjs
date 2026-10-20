#!/usr/bin/env node
/**
 * 本机验证用的静态文件服务：支持 HTTP Range（差量更新只按 Range 取 zip 里变了的那几段），
 * 每个请求打一行，最后一列是累计发出去的字节数——差量到底下了多少，看这一列（2026-10-20）。
 *
 *   node desktop/scripts/perf/serve-range.mjs <目录> <端口>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [目录, 端口] = process.argv.slice(2);
let 累计 = 0;
http
  .createServer((req, res) => {
    const 文件 = path.resolve(目录, "." + decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!文件.startsWith(path.resolve(目录)) || !fs.existsSync(文件)) {
      res.statusCode = 404;
      return res.end();
    }
    const 大小 = fs.statSync(文件).size;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    const 起 = m ? Number(m[1]) : 0;
    const 止 = m && m[2] ? Number(m[2]) : 大小 - 1;
    res.writeHead(m ? 206 : 200, { "accept-ranges": "bytes", "content-length": 止 - 起 + 1, ...(m ? { "content-range": `bytes ${起}-${止}/${大小}` } : {}) });
    累计 += 止 - 起 + 1;
    fs.createReadStream(文件, { start: 起, end: 止 }).pipe(res);
    console.log(`${req.method} ${req.url} ${req.headers.range || ""} 累计 ${(累计 / 1048576).toFixed(1)} MB`);
  })
  .listen(Number(端口), "127.0.0.1", () => console.log(`在 http://127.0.0.1:${端口}/ 提供 ${目录}`));
