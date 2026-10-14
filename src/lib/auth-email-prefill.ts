"use client";

import {useState,useSyncExternalStore} from "react";

// 只在用户点登录/找回链接时交接邮箱，五分钟后失效；不进URL或持久存储。
const key="crm:auth-email-handoff";
type Handoff={email:string;until:number};
let memory:Handoff|null=null;
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}};
function validEmail(raw:unknown):string{
 const email=typeof raw==="string"?raw.trim():"";
 return email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:"";
}
function read():string{
 let value:unknown=memory;
 try{const stored=sessionStorage.getItem(key);value=stored?JSON.parse(stored):memory}catch{/* 禁止存储时只保留本标签页内存 */}
 if(!value||typeof value!=="object")return "";
 const data=value as Handoff;
 return Number.isFinite(data.until)&&data.until>Date.now()&&data.until<=Date.now()+5*60_000?validEmail(data.email):"";
}
export function 记找回邮箱(raw:unknown){
 const email=validEmail(raw);
 memory=email?{email,until:Date.now()+5*60_000}:null;
 try{if(memory)sessionStorage.setItem(key,JSON.stringify(memory));else sessionStorage.removeItem(key)}catch{/* 内存兜底 */}
 listeners.forEach(listener=>listener());
}
const empty=()=>"";
export function usePrefilledEmail(){return useSyncExternalStore(subscribe,read,empty)}
export function useLoginEmail(enabled=true):[string,(value:string)=>void]{
 const saved=usePrefilledEmail();
 const [edited,setEdited]=useState<string|null>(null);
 return [edited??(enabled?saved:""),setEdited];
}
