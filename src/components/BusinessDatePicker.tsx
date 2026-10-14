"use client";

import { DatePicker } from "antd";
import type { Dayjs } from "dayjs";
import dayjsGenerateConfig from "@rc-component/picker/generate/dayjs";
import { businessDayjs, businessTimeZone } from "@/lib/business-clock";

/** 日期面板的今天/此刻及键盘输入也使用业务时区，防止与页面分组、服务端保存不同日。 */
const BusinessDatePicker = DatePicker.generatePicker<Dayjs>({
  ...dayjsGenerateConfig,
  getNow: () => businessDayjs(),
  getFixedDate: value => businessDayjs(dayjsGenerateConfig.getFixedDate(value).format("YYYY-MM-DD")),
  locale: {
    ...dayjsGenerateConfig.locale,
    parse: (locale, text, formats) => {
      if (!businessTimeZone()) return dayjsGenerateConfig.locale.parse(locale, text, formats);
      // 先按UTC校验墙钟文本，纽约不存在的02:30并不影响北京同日合法的02:30。
      for (const format of formats) {
        const parsed = /[wW]o/.test(format)
          ? dayjsGenerateConfig.locale.parse(locale, text, [format])
          : businessDayjs.utc(text, format, true);
        if (parsed?.isValid()) return businessDayjs(parsed.format("YYYY-MM-DDTHH:mm:ss.SSS")).locale(locale === "zh_CN" ? "zh-cn" : locale.split("_")[0]);
      }
      return null;
    },
  },
});
export default BusinessDatePicker;
