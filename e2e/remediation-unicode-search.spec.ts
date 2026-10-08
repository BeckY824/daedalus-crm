import {test,expect,type Page} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;
 await db.customer.createMany({data:[{id:"unicode-web-german",name:"MÜLLER"},{id:"unicode-web-russian",name:"МОСКВА"},{id:"unicode-web-order",name:"QA订单档案"},{id:"unicode-web-decoy",name:"QA干扰档案"}].map(row=>({...row,phone:"",salesOwnerId:owner}))});
 await db.contact.create({data:{customerId:"unicode-web-order",name:"ЖАН_100%[A]*?",phone:""}});
 await db.tradeOrder.create({data:{customerId:"unicode-web-order",ownerId:owner,no:"PI_100%[A]*?",amount:10}});
 await db.contact.create({data:{customerId:"unicode-web-decoy",name:"ЖАНx100分Axyz",phone:""}});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
async function login(page:Page){await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/)}
test("实际搜索框回车及冷加载德文/俄文大小写一致，订单号与联系人按字面查找",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers");
 const box=page.getByPlaceholder(/姓名 \/ 电话.*订单号/);await expect(box).toBeVisible();
 for(const [word,name] of [["müller","MÜLLER"],["москва","МОСКВА"],["pi_100%[a]*?","QA订单档案"],["жан_100%[a]*?","QA订单档案"]]){
  await box.fill(word);await box.press("Enter");await page.waitForURL(url=>url.searchParams.get("keyword")===word);
  await expect(page.locator("tbody tr[data-row-key]")).toHaveCount(1);await expect(page.locator("tbody tr[data-row-key]")).toContainText(name);
 }
 await page.reload();await expect(page.locator("tbody tr[data-row-key]")).toContainText("QA订单档案");expect(errors).toEqual([]);
});
