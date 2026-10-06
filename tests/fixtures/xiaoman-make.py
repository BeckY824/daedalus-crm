#!/usr/bin/env python3
"""
生成 tests/fixtures/小满式-客户导出.xlsx（2026-10-06 测试分期 B.7）。

没有客户脱敏的真导出，就照**小满官方的客户导入模板**（帮助中心公开下载的那份，22 列，
~/CRM/小满细拆-2026-09-25/附件/小满-客户导入模板.xlsx）的表头原样拼，再加上导出时常带的几列
（跟进人、创建时间、最近跟进时间）。数据照小满表的常见样子造：
同一公司多联系人分多行、公司名带尾巴空格、地址里夹零宽字符、美国号码写成 1-8667527753、
只有邮箱没电话的、模板自带的那行说明文字、标签用分号连着、日期是真日期格。

    python3 tests/fixtures/xiaoman-make.py
"""
from openpyxl import Workbook
from datetime import datetime
import os

头 = ['公司名称', '联系人昵称', '联系人邮箱', '公司简称', '国家地区', '标签', '客户阶段', '客户来源', '公司网址', '座机',
      '详细地址', '公司备注', '客户编号', '公海分组', '联系人电话', 'Facebook', 'Twitter', 'LinkedIn', '职位', '性别',
      '联系人备注', '业务类型', '跟进人', '创建时间', '最近跟进时间']
行 = [
    # 1 完整的一行（模板自带的样例）
    ['Apple, Inc ', 'Tim Cook', 'example@apple.com', 'Apple', '美国', '标签1;标签2;标签3', '待跟进', '官网询盘', 'www.apple.com', '1-8667527753',
     'One Apple Park Way Cupertino, CA 95014 ​​​​', '蓝底为公司字段', 11235, None, '1-8002752273', 'https://www.facebook.com/apple/',
     'https://twitter.com/Apple', 'https://www.linkedin.cn/company/apple/', 'CEO', '男', '橙底为联系人字段', '业务类型名称', '王小满',
     datetime(2026, 3, 2, 10, 15), datetime(2026, 9, 28, 16, 40)],
    # 2 模板自带的说明行：同一公司第二个联系人，只有一句话、没有任何号码
    ['Apple, Inc ', '同一公司有多个联系人时，请分多行录入，保持公司信息一致。'] + [None] * 23,
    # 3 同一公司第二位联系人，号码带 + 和空格
    ['Apple, Inc ', 'Jeff Williams', 'jeff@apple.com', 'Apple', '美国', None, '报价中', '展会', None, None,
     None, None, 11236, None, '+1 408 996 1010', None, None, None, 'COO', '男', None, None, '王小满', datetime(2026, 4, 1), None],
    # 4 中东客户：手机号带国家码写在电话里，阶段是自定义的
    ['Gulf LED Trading LLC', 'Ahmed Al Mansouri', 'ahmed@gulfled.ae', 'Gulf LED', '阿联酋', 'VIP', '样品阶段', 'Alibaba', 'gulfled.ae', '+971 4 123 4567',
     'Dubai, UAE', '要户外 P4', 11237, None, '+971 50 123 4567', None, None, None, '采购经理', '男', '只在 WhatsApp 回', None, '李业务', datetime(2026, 5, 20), datetime(2026, 10, 1)],
    # 5 只有邮箱、没有任何电话（小满里常见：邮件开发来的客户）
    ['Bright Signs GmbH', 'Anna Becker', 'anna@brightsigns.de', None, '德国', None, '待跟进', '邮件开发', 'brightsigns.de', None,
     None, None, 11238, '德国公海', None, None, None, 'https://www.linkedin.com/in/annabecker', 'Einkauf', '女', None, None, None, datetime(2026, 6, 3), None],
    # 6 只有座机（公司总机），没有联系人电话
    ['Andes Pantallas SAC', 'Carlos Ruiz', 'carlos@andes.pe', None, '秘鲁', None, '待跟进', 'Google', None, '+51 1 234 5678',
     'Lima', None, 11239, None, None, None, None, None, 'Gerente', '男', None, None, '李业务', datetime(2026, 7, 9), None],
    # 7 联系人电话被 Excel 存成数字
    ['Lagos Screens Ltd', 'Chinedu Okafor', None, None, '尼日利亚', None, '已成交', '老客户介绍', None, None,
     None, '返单客户', 11240, None, 2348031234567, None, None, None, 'CEO', '男', None, None, '王小满', datetime(2025, 12, 1), datetime(2026, 9, 2)],
]
wb = Workbook()
ws = wb.active
ws.title = '客户'
ws.append(头)
for r in 行:
    ws.append(r)
out = os.path.join(os.path.dirname(__file__), '小满式-客户导出.xlsx')
wb.save(out)
print(out)
