import {test,expect} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;await db.customer.create({data:{id:"summary-customer",name:"QA汇总客户",phone:"",salesOwnerId:owner}});await db.contract.create({data:{customerId:"summary-customer",amount:123456789,signedAt:new Date()}});await db.followUp.create({data:{id:"summary-follow",customerId:"summary-customer",ownerId:owner,occurredAt:new Date(),type:"PHONE",title:"QA时间线标题",content:"QA正文紧随标题",status:"已完成"}});for(const row of [{id:"summary-open",name:"QA进行中",stage:"初步沟通",status:"OPEN",amount:100,currency:"USD"},{id:"summary-won",name:"QA已赢单",stage:"赢单成交",status:"WON",amount:200,currency:"CNY"},{id:"summary-lost",name:"QA已丢单",stage:"需求确认",status:"LOST",amount:300,currency:"CNY"}]){const {currency,...data}=row;await db.opportunity.create({data:{...data,customerId:"summary-customer",ownerId:owner,money:{create:{currency}}}})}}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
test("未筛状态的列表总数与进行中合计分别标明，阶段与状态筛选不矛盾",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/);
 await page.goto("/opportunities");const summary=page.getByRole("main").locator(".list-sum");await expect(summary).toContainText("列表共 3 单 · 其中进行中 1 单");await expect(summary).toContainText("US$ 100");await expect(summary).not.toContainText("¥ 600");
 await page.goto("/opportunities?stage="+encodeURIComponent("赢单成交"));await expect(summary).toContainText("列表共 1 单 · 其中进行中 0 单");await expect(page.getByRole("main").locator("tbody tr[data-row-key]")).toHaveCount(1);await expect(page.getByRole("main")).toContainText("QA已赢单");
 await page.goto("/opportunities?status=WON");await expect(summary).toContainText("列表共 1 单 · 已赢单 1 单");await expect(summary).toContainText("¥ 200");await expect(summary).not.toContainText("加权预测");expect(errors).toEqual([]);
});


test("详情金额不被日期挤成省略号，时间线无空白行，报表及回填时间提示说明真实口径",async({page})=>{
 await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/);
 for(const width of [1280,1440]){await page.setViewportSize({width,height:900});await page.goto("/customers/summary-customer");const main=page.getByRole("main");const money=main.locator(".rec-mini-amt");await expect(money).toHaveText("¥ 123,456,789");await expect(money).toBeVisible();expect(await money.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  const head=await main.locator("#fu-summary-follow .rec-tl-head").boundingBox();const body=await main.locator("#fu-summary-follow .rec-tl-content").boundingBox();expect(head!.height).toBeLessThanOrEqual(30);expect(body!.y-(head!.y+head!.height)).toBeLessThanOrEqual(10);
 }
 await page.getByRole("main").getByRole("button",{name:"登记签约",exact:true}).click();await expect(page.getByRole("dialog")).toContainText("赢单时间记录本次操作时间");await page.getByRole("dialog").getByRole("button",{name:/取\s*消/}).click();
 await page.goto("/overview?view="+encodeURIComponent("本月"));await expect(page.getByRole("main")).toContainText("签约时归属；老记录缺快照时按当前");await expect(page.getByRole("main")).toContainText("客户当前归属");
});
