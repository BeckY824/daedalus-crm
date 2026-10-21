// 服务器认名片线程池的测试替身（tests/card-scan-server.test.ts）：按「模型」名演各种情况，不真认
import { parentPort } from "node:worker_threads";
parentPort.on("message", async (x) => {
  if (x.预热) return;
  const [怎样, 毫秒] = String(x.模型).split(":");
  if (怎样 === "崩") process.exit(3);
  if (怎样 === "卡") return;
  await new Promise((ok) => setTimeout(ok, Number(毫秒 || 0)));
  if (怎样 === "坏") parentPort.postMessage({ id: x.id, 错: "认不了" });
  else parentPort.postMessage({ id: x.id, items: [{ poly: [], text: `${x.模型}#${x.图.length}`, score: 1 }] });
});
