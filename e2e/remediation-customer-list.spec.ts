import { test,expect,type Page } from "@playwright/test";
import {连库,清空业务数据} from "./mock-data";
test.describe.configure({mode:"serial"});
test.beforeAll(async()=>{const db=连库();try{
 await 清空业务数据(db);const owner=(await db.user.findUniqueOrThrow({where:{email:"zhangsan"}})).id;
 await db.customer.createMany({data:Array.from({length:25},(_,i)=>({id:`sort-${String(i).padStart(3,"0")}`,name:`排序客户${i}`,phone:`138${String(i).padStart(8,"0")}`,salesOwnerId:owner,followStatus:"跟进中",createdAt:new Date(Date.UTC(2026,0,26-i))}))});
 await db.contract.createMany({data:Array.from({length:25},(_,i)=>({customerId:`sort-${String(i).padStart(3,"0")}`,amount:i+1,signedAt:new Date("2026-01-01")}))});
}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
async function login(page:Page){await page.goto("/login");await page.getByPlaceholder("用户名").fill("zhangsan");await page.getByPlaceholder("登录密码").fill("admin123");await page.getByRole("button",{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/)}
test("实际表头排序跨页执行，全部范围及币种说明可见",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers?pageSize=10");
 await page.getByRole("button",{name:"选择要显示的列"}).click();await page.getByRole("checkbox",{name:"签约金额",exact:true}).check();await page.getByRole("button",{name:"选择要显示的列"}).click();
 const header=page.locator("th.dl-col-signedAmount");await header.click();await page.waitForURL(/sort=amount-asc/);await header.click();await page.waitForURL(/sort=amount-desc/);
 await expect(page.locator("tbody tr[data-row-key]").first()).toContainText("排序客户24");await expect(page.getByText(/在全部筛选结果中降序排列；其他币种不相加/)).toBeVisible();
 expect(new URL(page.url()).searchParams.get("pageSize")).toBe("10");await page.locator('.ant-pagination-item[title="2"]').click();await page.waitForURL(/page=2/);await expect(page.locator("tbody tr[data-row-key]").first()).toContainText("排序客户14");
 expect(new URL(page.url()).searchParams.get("sort")).toBe("amount-desc");expect(errors).toEqual([]);
});
test("每页50条筛选后保留，重置与前进后退的筛选显示正确",async({page})=>{
 await login(page);await page.goto("/customers?pageSize=50");
 const status=page.locator(".ant-select").filter({hasText:"全部跟进状态"});await status.click();await page.locator('.ant-select-dropdown:visible').getByTitle("跟进中",{exact:true}).click();await page.waitForURL(/followStatus=/);
 expect(new URL(page.url()).searchParams.get("pageSize")).toBe("50");await expect(page.locator("tbody tr[data-row-key]")).toHaveCount(25);
 await page.goBack();await expect(page.locator(".ant-select").filter({hasText:"全部跟进状态"})).toBeVisible();
 await page.goForward();await expect(page.locator(".ant-select").filter({hasText:"跟进中"})).toBeVisible();expect(new URL(page.url()).searchParams.get("pageSize")).toBe("50");
 await page.getByRole("button",{name:/重\s*置/}).click();await page.waitForURL(url=>!url.searchParams.has("followStatus"));
 expect(new URL(page.url()).searchParams.get("pageSize")).toBe("50");await expect(page.locator(".ant-select").filter({hasText:"全部跟进状态"})).toBeVisible();
});
test("坏页码与超末页冷加载能看到有效页且无浏览器错误",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);await page.goto("/customers?page=abc&pageSize=10");await expect.poll(()=>new URL(page.url()).searchParams.get("page")).toBe("1");await expect(page.locator("tbody tr[data-row-key]:visible")).toHaveCount(10);
 await page.goto("/customers?page=999&pageSize=10");await expect.poll(()=>new URL(page.url()).searchParams.get("page")).toBe("3");await expect(page.locator("tbody tr[data-row-key]:visible")).toHaveCount(5);expect(errors).toEqual([]);
});

test("B6 删除末页后页码、地址与筛选一致，刷新仍正确",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));await login(page);
 await page.goto("/customers?keyword=排序客户&pageSize=10&page=3&sort=amount-desc&sortCurrency=CNY#qa-page");
 await expect(page.locator("tbody tr[data-row-key]:visible")).toHaveCount(5);
 const ids=await page.locator("tbody tr[data-row-key]:visible").evaluateAll(rows=>rows.map(r=>r.getAttribute("data-row-key")!));
 const db=连库();try{await db.customer.deleteMany({where:{id:{in:ids}}})}finally{await db.$disconnect()}
 await page.reload();await expect.poll(()=>new URL(page.url()).searchParams.get("page")).toBe("2");
 await expect(page.locator("tbody tr[data-row-key]:visible")).toHaveCount(10);
 const url=new URL(page.url());expect(url.searchParams.get("keyword")).toBe("排序客户");expect(url.searchParams.get("sort")).toBe("amount-desc");expect(url.searchParams.get("pageSize")).toBe("10");expect(url.hash).toBe("#qa-page");
 await page.reload();await expect(page.locator(".ant-pagination-item-active:visible")).toHaveText("2");expect(errors).toEqual([]);
});
