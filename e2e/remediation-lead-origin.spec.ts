import {test,expect,type Page} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;
 await db.customer.createMany({data:[{id:"origin-web",name:"QA可追溯客户"},{id:"origin-web-none",name:"QA手动客户"}].map(row=>({...row,phone:"",salesOwnerId:owner}))});
 await db.lead.create({data:{id:"origin-web-lead",name:"QA原始展会询盘",source:"展会",customerId:"origin-web",ownerId:owner,status:"已转化",convertedAt:new Date("2026-09-20T02:15Z")}});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
async function login(page:Page){await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/)}
test("实际客户详情冷加载显示来源线索而手动客户不伪造，未记录转化时间明确展示",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers/origin-web");
 const origin=page.getByRole("main").getByTestId("customer-lead-origin");await expect(origin).toContainText("QA原始展会询盘 · 展会");await expect(origin).toContainText("origin-web-lead");await expect(origin).toContainText("2026-09-20 10:15");
 await page.reload();await expect(origin).toContainText("QA原始展会询盘");
 const db=连库();try{await db.lead.update({where:{id:"origin-web-lead"},data:{convertedAt:null}})}finally{await db.$disconnect()}
 await page.reload();await expect(origin).toContainText("转化时间 未记录");await page.goto("/customers/origin-web-none");await expect(page.getByRole("main").getByTestId("customer-lead-origin")).toHaveCount(0);expect(errors).toEqual([]);
});
