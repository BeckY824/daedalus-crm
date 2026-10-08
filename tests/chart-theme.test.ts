import {it,expect,vi} from "vitest";
import {主题图表选项} from "@/lib/chart-theme";
import {palette,alpha} from "@/lib/palette";
it("颜色递归保留原始数据/名称/回调与非普通对象，仅转换颜色字段",()=>{
 const fn=vi.fn(),date=new Date();const option={color:[palette.brand,palette.success],series:[{name:palette.brand,data:[palette.brand,10],itemStyle:{color:palette.brand},areaStyle:{color:{colorStops:[{color:alpha(palette.brand,.25)}]}},formatter:fn,custom:date}],backgroundColor:palette.panel,textStyle:{color:palette.onInk}};
 const result=主题图表选项(option,t=>({"--brand":"#123456","--success":"#345678","--panel":"#abcdef","--on-ink":"#ffffff"} as Record<string,string>)[t]??"");
 expect(result.color).toEqual(["#123456","#345678"]);expect(result.series[0].name).toBe(palette.brand);expect(result.series[0].data).toEqual([palette.brand,10]);expect(result.series[0].itemStyle.color).toBe("#123456");expect(result.series[0].areaStyle.color.colorStops[0].color).toBe("#12345640");expect(result.backgroundColor).toBe("#abcdef");expect(result.textStyle.color).toBe("#ffffff");expect(result.series[0].formatter).toBe(fn);expect(result.series[0].custom).toBe(date);expect(option.series[0].itemStyle.color).toBe(palette.brand);
});
it("不存在的token、未知颜色及无法安全合成alpha的色值保留原值",()=>{
 const option={color:"var(--missing)",itemStyle:{color:"unknown"},lineStyle:{color:alpha(palette.brand,.25)}};expect(主题图表选项(option,()=>"")).toEqual(option);expect(主题图表选项(option,t=>t==="--brand"?"rgb(1,2,3)":"").lineStyle.color).toBe(alpha(palette.brand,.25));
});
