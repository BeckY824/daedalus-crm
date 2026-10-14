import {afterAll,beforeAll,expect,it} from "vitest";
import {build,type Plugin} from "esbuild";
import path from "node:path";
import {chromium,type Browser} from "playwright";
let browser:Browser,bundle:string;
const plugin:Plugin={name:"auth-prefill-boundaries",setup(b){
 const stub=(filter:RegExp,contents:string)=>{b.onResolve({filter},a=>({path:a.path,namespace:"stub",pluginData:contents}))};
 stub(/^\.\/actions$/,`const call=(name,...args)=>{window.__calls.push({name,args});return Promise.resolve({ok:true})};export const login=(...a)=>call('login',...a);export const 桌面端登录=(...a)=>call('login',...a);export const 桌面端下一步=async()=>({ok:true,data:{去:'密码'}});export const 桌面端注册=(...a)=>call('register',...a);export const 桌面端核对码=async()=>({对:true});export const 核对重置码=async()=>({对:true});export const 发送重置码=(...a)=>call('send',...a);export const 重置密码=(...a)=>call('reset',...a);`);
 stub(/^\.\/after-login$/,"export const 登录之后=async()=>{};");stub(/AuthSide$/,"export default()=>null;");
 stub(/^next\/link$/,"import React from 'react';export default({href,children,onClick,...p})=>React.createElement('a',{href,...p,onClick:e=>{onClick?.(e);e.preventDefault();history.pushState({},'',href);window.__render(href==='/forgot'?'forgot':'login')}},children);");
 b.onLoad({filter:/.*/,namespace:"stub"},a=>({contents:a.pluginData,loader:"jsx",resolveDir:process.cwd()}));
}};
beforeAll(async()=>{bundle=(await build({stdin:{contents:`
 import React from'react';import{createRoot}from'react-dom/client';import Login from'@/app/login/LoginForm';import Desktop from'@/app/login/DesktopAuth';import Forgot from'@/app/forgot/ForgotForm';import DesktopForgot from'@/app/forgot/DesktopForgot';import Brand from'@/app/login/TypeBrand';
 const root=createRoot(document.getElementById('root'));window.__calls=[];window.__render=(which)=>root.render(which==='brand'?<Brand/>:which==='nothing'?null:which==='login'?(window.__desktop?<Desktop 可找回密码={true} 可注册={false} 应用内注册={true} 注册地址=''/>:<Login 用邮箱={true} 可找回密码={true}/>):(window.__desktop?<DesktopForgot 可用={true}/>:<Forgot/>));
 `,loader:"tsx",resolveDir:process.cwd()},bundle:true,write:false,format:"iife",jsx:"automatic",alias:{"@":path.resolve("src")},define:{"process.env.NODE_ENV":'"production"'},plugins:[plugin],logLevel:"silent"})).outputFiles[0].text;browser=await chromium.launch()});
afterAll(async()=>{await browser?.close()});
async function open(desktop=false){const page=await browser.newPage();page.setDefaultTimeout(5000);await page.emulateMedia({reducedMotion:"reduce"});await page.route("http://prefill.test/**",r=>r.fulfill({contentType:"text/html",body:"<meta charset='utf-8'><div id='root'></div>"}));await page.goto("http://prefill.test/login");await page.evaluate(value=>Reflect.set(window,"__desktop",value),desktop);await page.addScriptTag({content:bundle});await page.evaluate(()=>Reflect.get(window,"__render")("login"));return page}
it.each([false,true])("桌面=%s，忘记密码/返回只保留邮箱，不带密码、不自动发码",async(desktop)=>{const page=await open(desktop);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));try{
 const actual=desktop?page.locator("#auth-email"):page.getByPlaceholder("邮箱",{exact:true});
 await actual.fill("QA+tag@example.test");if(desktop)await page.getByRole("button",{name:/继\s*续/}).click();
 await page.locator('input[autocomplete="current-password"]').fill("Secret-never-store-123");await page.getByRole("link",{name:"忘记密码？"}).click();
 const target=desktop?page.locator('input[autocomplete="email"]').first():page.getByPlaceholder("注册时用的邮箱");
 await expect.poll(()=>target.inputValue()).toBe("QA+tag@example.test");expect(await page.evaluate(()=>Reflect.get(window,"__calls"))).toEqual([]);
 expect(new URL(page.url()).search).toBe("");expect(await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}))).not.toContain("Secret-never-store");
 await target.fill("changed@example.test");await page.getByRole("link",{name:"去登录",exact:true}).click();
 const back=desktop?page.locator("#auth-email"):page.getByPlaceholder("邮箱",{exact:true});await expect.poll(()=>back.inputValue()).toBe("changed@example.test");if(desktop)await page.getByRole("button",{name:/继\s*续/}).click();expect(await page.locator('input[autocomplete="current-password"]').inputValue()).toBe("");expect(errors).toEqual([]);
}finally{await page.close()}});
it("同一浏览会话切页后品牌不重新打字，首次中途离开也不重播",async()=>{const page=await open();try{
 await page.emulateMedia({reducedMotion:"no-preference"});await page.clock.install();await page.evaluate(()=>Reflect.get(window,"__render")("brand"));await page.locator(".auth-brand").waitFor();expect(await page.locator(".auth-brand-todo").count()).toBeGreaterThan(0);
 await page.clock.runFor(900);await page.evaluate(()=>Reflect.get(window,"__render")("nothing"));await expect.poll(()=>page.locator(".auth-brand").count()).toBe(0);
 await page.evaluate(()=>Reflect.get(window,"__render")("brand"));await page.locator(".auth-brand").waitFor();await expect.poll(()=>page.locator(".auth-brand-todo").count()).toBe(0);expect(await page.locator(".auth-brand-caret").count()).toBe(0);
}finally{await page.close()}});

it("过期和损坏的交接邮箱不预填、不自动发送验证码",async()=>{for(const value of [JSON.stringify({email:"expired@example.test",until:Date.now()-1}),"{bad-json",JSON.stringify({email:"bad-email",until:Date.now()+60_000})]){const page=await open();try{
 await page.evaluate(v=>{sessionStorage.setItem("crm:auth-email-handoff",v);Reflect.get(window,"__render")("forgot")},value);
 await expect.poll(()=>page.getByPlaceholder("注册时用的邮箱").inputValue()).toBe("");expect(await page.evaluate(()=>Reflect.get(window,"__calls"))).toEqual([]);
 }finally{await page.close()}}});
it("浏览器禁止存储时仍可安全交接邮箱",async()=>{const page=await open();try{
 await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new DOMException("blocked","SecurityError")};Storage.prototype.getItem=()=>{throw new DOMException("blocked","SecurityError")}});
 await page.getByPlaceholder("邮箱",{exact:true}).fill("memory@example.test");await page.getByRole("link",{name:"忘记密码？"}).click();await expect.poll(()=>page.getByPlaceholder("注册时用的邮箱").inputValue()).toBe("memory@example.test");expect(await page.evaluate(()=>Reflect.get(window,"__calls"))).toEqual([]);
 }finally{await page.close()}});
