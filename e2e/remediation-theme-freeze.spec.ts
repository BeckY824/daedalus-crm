import {test,expect} from '@playwright/test';
import {连库,清空业务数据} from './mock-data';
test.beforeAll(async()=>{const db=连库();try{await 清空业务数据(db);await db.setting.deleteMany({where:{key:'business'}});const u=await db.user.findUniqueOrThrow({where:{email:'zhangsan'}});await db.customer.create({data:{id:'theme-freeze',name:'QA主题日期',phone:'13800002233',salesOwnerId:u.id,followStatus:'意向较高',lastFollowAt:new Date('2025-10-08T12:34:00+08:00')}})}finally{await db.$disconnect()}});
test.afterAll(async()=>{const db=连库();try{await 清空业务数据(db)}finally{await db.$disconnect()}});
test('五主题1280/1440真实客户表日期保持单行可读，高级主题行高44，首页新增月指标与周走势分开',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/login');await page.getByPlaceholder('用户名').fill('zhangsan');await page.getByPlaceholder('登录密码').fill('admin123');await page.getByRole('button',{name:/登\s*录/}).click();await page.waitForURL(/\/dashboard/);
 await expect(page.getByRole('main').getByText('新增客户走势（近8周）',{exact:true})).toBeVisible();await expect(page.getByRole('main').getByText('按建档日期，每周新增数量',{exact:true})).toBeVisible();expect(await page.getByRole('main').getByText('新增客户（本月）',{exact:true}).count()).toBe(0);
 await page.goto('/customers');const row=page.getByRole('row').filter({hasText:'QA主题日期'});await row.waitFor();
 for(const width of [1280,1440]){await page.setViewportSize({width,height:900});for(const skin of ['now','tech','pixel','ledger','luxe']){await page.evaluate(s=>{document.documentElement.dataset.skin=s},skin);
 const date=row.locator('.heat-cell .nowrap');await expect(date).toContainText('2025 年 10 月 8 日');
 const geometry=await date.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const boxes=[...r.getClientRects()];const td=el.closest('td')!;return {lines:boxes.length,whiteSpace:getComputedStyle(el).whiteSpace,textRight:boxes[0]?.right,cellRight:td.getBoundingClientRect().right,rowHeight:td.getBoundingClientRect().height,font:getComputedStyle(el).fontFamily}});
 expect(geometry.lines,`${skin}/${width}日期换行`).toBe(1);expect(geometry.whiteSpace).toBe('nowrap');expect(geometry.textRight,`${skin}/${width}日期溢出单元格`).toBeLessThanOrEqual(geometry.cellRight+1);
 if(skin==='luxe')expect(geometry.rowHeight).toBeLessThanOrEqual(45);
 if(skin==='tech'||skin==='pixel')expect(geometry.font).toMatch(/PingFang|Microsoft YaHei/);
 }}expect(errors).toEqual([]);
});
