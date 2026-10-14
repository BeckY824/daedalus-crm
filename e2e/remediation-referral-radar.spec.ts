import {test,expect} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;
 await db.customer.create({data:{id:"radar-web-parent",name:"QA推荐人",phone:"",salesOwnerId:owner}});
 await db.customer.createMany({data:[{id:"radar-web-status",name:"QA仅状态已成交",followStatus:"已签约",referrerCustomerId:"radar-web-parent"},{id:"radar-web-real",name:"QA实际签约客户",followStatus:"已流失",referrerCustomerId:"radar-web-parent"},{id:"radar-web-zero",name:"QA零额合同",followStatus:"跟进中"}].map(row=>({...row,phone:"",salesOwnerId:owner}))});
 await db.contract.create({data:{customerId:"radar-web-real",amount:999,signedAt:new Date(),money:{create:{currency:"USD",amountExact:120.51}}}});await db.contract.create({data:{customerId:"radar-web-zero",amount:0,signedAt:new Date()}});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
test("生产渠道雷达对齐真实签约、精确金额，建议不编造邀请历史",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/);await page.goto("/channels");
 const radar=page.getByRole("main").locator(".ant-card").filter({hasText:"转介绍雷达"});await expect(radar).toBeVisible();
 const row=radar.getByRole("row").filter({hasText:"QA推荐人"});await expect(row.getByRole("cell")).toHaveText(["QA推荐人","2","1","US$ 120.51"]);
 await expect(radar).toContainText("尚无直接推荐记录");await expect(radar).toContainText("QA零额合同");await expect(radar).toContainText("QA实际签约客户");await expect(radar).not.toContainText("QA仅状态已成交");await expect(radar).not.toContainText("没请");await expect(radar).toContainText("不换汇");
 await page.reload();await expect(radar.getByRole("row").filter({hasText:"QA推荐人"}).getByRole("cell")).toHaveText(["QA推荐人","2","1","US$ 120.51"]);expect(errors).toEqual([]);
});
