import {test,expect,type Page} from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;
 await db.customer.createMany({data:[{id:"delete-parent",name:"被依赖客户",phone:"13800000001",salesOwnerId:owner},{id:"delete-free",name:"可删客户",phone:"13800000002",salesOwnerId:owner}]});
 await db.customer.create({data:{id:"delete-child",name:"下游客户",phone:"13800000003",salesOwnerId:owner,referrerCustomerId:"delete-parent"}});
 await db.contact.create({data:{id:"preserved-contact",customerId:"delete-free",name:"保留下来的联系人",phone:"13800000004",isPrimary:true}});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
async function login(page:Page){await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/)}
async function ask(page:Page){await page.getByRole("button",{name:"客户更多操作"}).click();await page.getByRole("menuitem",{name:/删除这位客户/}).click()}
test("详情删除入口先提示推荐依赖，不弹不可执行的最终确认且没有写库",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers/delete-parent");await ask(page);
 await expect(page.getByText(/整批已阻止：被依赖客户/)).toBeVisible();expect(await page.getByRole("dialog").count()).toBe(0);
 const db=连库();try{expect(await db.customer.count()).toBe(3);expect(await db.unassignedContact.count()).toBe(0)}finally{await db.$disconnect()}expect(errors).toEqual([]);
});
test("详情删除取消不写入，确认后回列表且联系人进入未归属",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers/delete-free");await ask(page);
 const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();await expect(dialog.getByText("删除后不能恢复。")).toBeVisible();await expect(dialog.getByText(/1 位联系人不删/)).toBeVisible();
 await dialog.getByRole("button",{name:/取\s*消/}).click();await expect(dialog).toBeHidden();
 const db=连库();try{expect(await db.customer.findUnique({where:{id:"delete-free"}})).not.toBeNull();expect(await db.unassignedContact.count()).toBe(0)}finally{await db.$disconnect()}
 await ask(page);await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:/删\s*除/}).click();await page.waitForURL(/\/customers(?:\?|$)/);
 const check=连库();try{expect(await check.customer.findUnique({where:{id:"delete-free"}})).toBeNull();expect(await check.unassignedContact.findUnique({where:{id:"preserved-contact"}})).toMatchObject({name:"保留下来的联系人",wasPrimary:true,fromCustomerId:"delete-free"})}finally{await check.$disconnect()}
 expect(errors).toEqual([]);
});
