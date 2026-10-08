import {palette,categorical} from "./palette";

const kebab=(s:string)=>s.replace(/[A-Z]/g,c=>"-"+c.toLowerCase());
const tokens=new Map<string,string>([
 ...Object.entries(palette).map(([key,color])=>[color,`--${kebab(key)}`] as [string,string]),
 ...Object.entries(categorical).map(([key,color])=>[color,`--cat-${key}`] as [string,string]),
]);
/** 主题分类色用于DOM，浏览器自行响应CSS变量变化。 */
export function 主题颜色(color:string) {
 const token=tokens.get(color);
 return token?`var(${token}, ${color})`:color;
}

/** 只转换颜色属性，保持数据、名称、回调与调用方的原始option不变。 */
export function 主题图表选项<T>(option:T, read:(token:string)=>string):T {
 function color(value:string,key:string) {
   const match=/^(#[\da-f]{6})([\da-f]{2})?$/i.exec(value);
   const base=match?.[1].toLowerCase();
   const token=base===palette.panel ? (key==="backgroundColor"?"--panel":"--on-ink") : tokens.get(base??value);
   const explicit=/^var\((--[\w-]+)(?:,[^)]*)?\)$/.exec(value);
   const resolved=read(explicit?.[1]??token??"").trim();
   if(!resolved) return value;
   if(!match?.[2]) return resolved;
   if(/^#[\da-f]{6}$/i.test(resolved))return resolved+match[2];
   return value; // 当前主题token均为六位hex；无法确认的格式保留原色和alpha。
 }
 function walk(value:unknown,key=""):unknown {
   const isColor=key==="color"||key.endsWith("Color");
   if(typeof value==="string")return isColor?color(value,key):value;
   if(Array.isArray(value))return value.map(v=>walk(v,key));
   if(value&&typeof value==="object"&&Object.getPrototypeOf(value)===Object.prototype)return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v,k)]));
   return value;
 }
 return walk(option) as T;
}
