import {test,expect,type Page} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{await 清空业务数据(db);await db.setting.deleteMany({where:{key:"business"}});const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;await db.lead.create({data:{id:"copy-lead",name:"QA待删线索",ownerId:owner}})}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db);await db.setting.deleteMany({where:{key:"business"}})}finally{await db.$disconnect()}});
async function login(page:Page){await page.goto("/login");await page.getByPlaceholder("用户名").fill("admin");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/)}
async function settings(page:Page){await page.goto("/settings?tab=business");const panel=page.getByRole("tabpanel",{name:"业务配置"});await expect(panel.locator("#customer")).toBeVisible();return panel}
test("切外贸整组待保存再生效，名词跨数据/成员/渠道一致，切设置分类零整页RSC",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);const panel=await settings(page);
 await panel.getByText("外贸",{exact:true}).click();await expect(panel.locator("#statusLabels_已签约")).toHaveValue("已下单");await expect(panel).toContainText("已填入「外贸出口」，还没保存");await expect(panel).toContainText("采购负责人");
 const db=连库();try{expect(await db.setting.findUnique({where:{key:"business"}})).toBeNull()}finally{await db.$disconnect()}
 await panel.locator("#customer").fill("伙伴");await panel.getByRole("button",{name:/^保\s*存$/}).first().click();await expect(page.getByText("已保存，全站措辞已更新")).toBeVisible();
 await page.goto("/overview");await expect(page.getByRole("main")).toContainText("伙伴趋势分析");await expect(page.getByRole("main")).toContainText("累计伙伴");
 await page.goto("/channels");await expect(page.getByRole("main")).toContainText("展会、线上平台、代理商");await expect(page.getByRole("main")).not.toContainText("家长社群");
 await page.goto("/settings?tab=members");await expect(page.getByRole("columnheader",{name:"负责伙伴"})).toBeVisible();await page.getByRole("button",{name:/新增成员/}).click();await expect(page.getByRole("dialog")).toContainText("销售主管与销售目前使用相同业务权限");await page.getByRole("dialog").getByRole("button",{name:/取\s*消/}).click();
 const rsc:string[]=[];page.on("request",r=>{if(r.method()==="GET"&&new URL(r.url()).pathname==="/settings"&&r.headers().rsc==="1")rsc.push(r.url())});
 for(const name of ["个人资料","登录与密码","业务配置","团队成员"]){await page.getByRole("tab",{name}).click();await expect(page.getByRole("tabpanel",{name})).toBeVisible()}
 expect(rsc).toEqual([]);expect(errors).toEqual([]);
});
test("线索删除明确不可恢复，取消无写入；渠道停用/启用名称一致",async({page})=>{
 await login(page);await page.goto("/leads");await page.getByRole("button",{name:"删除 QA待删线索"}).click();const confirm=page.getByRole("dialog");await expect(confirm).toContainText("删除后不可恢复");await confirm.getByRole("button",{name:/取\s*消/}).click();
 const db=连库();try{expect(await db.lead.count({where:{id:"copy-lead"}})).toBe(1);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;await db.channel.create({data:{id:"copy-channel",name:"QA渠道启停",channelOwnerId:owner}})}finally{await db.$disconnect()}
 await page.getByRole("button",{name:"删除 QA待删线索"}).click();await page.getByRole("dialog").getByRole("button",{name:/删\s*除/}).click();await expect(page.getByRole("button",{name:"删除 QA待删线索"})).toHaveCount(0);
 await page.goto("/channels");const row=page.getByRole("main").getByRole("row").filter({hasText:"QA渠道启停"});await expect(row).toContainText("已启用");await row.getByRole("button",{name:"停用 QA渠道启停"}).click();await expect(row).toContainText("已停用");await row.getByRole("button",{name:"启用 QA渠道启停"}).click();await expect(row).toContainText("已启用");
});
