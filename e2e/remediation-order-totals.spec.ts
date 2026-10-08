import {test,expect} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;const second=await db.user.create({data:{id:"qa-order-totals-second",name:"QA订单乙",email:"qa-order-totals-second",password:"unused",role:"SALES"}});
 await db.customer.createMany({data:[{id:"qa-orders-a",name:"QA订单甲",phone:"",salesOwnerId:owner},{id:"qa-orders-b",name:"QA订单乙",phone:"",salesOwnerId:second.id}]});
 await db.tradeOrder.createMany({data:Array.from({length:1001},(_,i)=>({id:`orders-web-${String(i).padStart(4,"0")}`,no:`QA-${i}`,ownerId:i<500?owner:second.id,customerId:i<500?"qa-orders-a":"qa-orders-b",amount:i<500?1:2,currency:i<500?"USD":"CNY"}))});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db);await db.user.deleteMany({where:{id:"qa-order-totals-second"}})}finally{await db.$disconnect()}});
test("1001单实际一览合计覆盖所有页，负责人筛选后币种/数量同步改变",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/);await page.goto("/orders");
 await expect(page.locator(".list-sum")).toContainText("共 1001 单");await expect(page.locator(".list-sum")).toContainText("1,002");await expect(page.locator(".list-sum")).toContainText("500");await expect(page.locator("tbody tr[data-row-key]")).toHaveCount(20);
 await page.locator('.ant-pagination-item[title="2"]').click();await expect(page.locator(".list-sum")).toContainText("共 1001 单");
 await page.locator(".ant-select").filter({hasText:"全部业务员"}).click();await page.locator(".ant-select-dropdown:visible").getByTitle("QA订单乙",{exact:true}).click();await page.waitForURL(/ownerId=qa-order-totals-second/);
 await expect(page.locator(".list-sum")).toContainText("共 501 单");await expect(page.locator(".list-sum")).toContainText("1,002");await expect(page.locator(".list-sum")).not.toContainText("US$");
 expect(errors).toEqual([]);
});
