/**
 * 建网页版那个唯一的共享工作区。
 *
 * 网页版不再是「谁注册谁得一个工作区」——它只有一个工作区、一套固定账号密码，
 * 由我们发给要试用的团队。注册那条路只开云端账号，给桌面端用。
 *
 * 用法（在应用目录里，带上托管版那套环境变量）：
 *
 *   MULTI_TENANT=1 CONTROL_DATABASE_URL=... WORKSPACE_DIR=... \
 *   npx tsx scripts/shared-workspace.ts <登录邮箱> <密码> [团队名] [slug]
 *
 * 建完把它给出的那行写进 .env 再重启容器：
 *
 *   SHARED_WORKSPACE=<slug>
 *
 * 没配 SHARED_WORKSPACE 的话，这个工作区照样能用，只是少了共享环境该有的两道防护：
 * 手机号不打码、设置页仍然摆着管理员那几栏（其中「测试连接」会拿平台 Key 往外发请求）。
 *
 * 到期日设在 2099 年：`computeWritable` 判的是 trialEndsAt > now，所以它永远可写。
 * **故意不标成已付费**——已付费等于 AI 不限次，而这套密码在多个团队手里，
 * 那就是把模型账单敞开。它按账本限次（注册赠送 + 每日补）。
 */
import { createAccount, findAccountByTarget, parseTarget } from "../src/lib/tenant/accounts";
import { createWorkspace } from "../src/lib/tenant/workspaces";

// tsx 在这个仓库里输出 CJS（package.json 没有 type: module），顶层 await 会被拒，所以包一层
async function main() {
  const [邮箱, 密码, 团队名 = "试用工作区", slug = "shared"] = process.argv.slice(2);
  if (!邮箱 || !密码) {
    console.error("用法：npx tsx scripts/shared-workspace.ts <登录邮箱> <密码> [团队名] [slug]");
    process.exit(1);
  }

  const t = parseTarget(邮箱);
  if (!t) {
    console.error(`认不出这个登录标识：${邮箱}`);
    process.exit(1);
  }

  const 已有 = await findAccountByTarget(t.value);
  if (已有) console.log(`账号已存在，直接用它：${邮箱}（密码不动）`);
  else console.log(`建了账号：${邮箱}`);
  const account = 已有
    ? { id: 已有.id, name: 已有.name, email: 已有.email, phone: 已有.phone }
    : await createAccount({ target: t, password: 密码, name: 团队名 });

  const ws = await createWorkspace({
    name: 团队名,
    account,
    slug,
    trialEndsAt: new Date("2099-12-31T00:00:00Z"),
  });

  console.log(`建了工作区：${团队名}  slug=${ws.slug}  库=${ws.dbFile}`);
  console.log("");
  console.log("把这一行写进 .env，然后 docker compose up -d：");
  console.log(`  SHARED_WORKSPACE=${ws.slug}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
