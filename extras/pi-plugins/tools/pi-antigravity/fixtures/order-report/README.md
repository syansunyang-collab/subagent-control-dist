# 订单汇总

`node cli.mjs "样例订单 10月.json"` 输出已支付订单的 JSON 报告。

接口：

- `toCents(value)`：将非负、至多两位小数的数字或数字字符串转换为整数分。
- `summarize(orders, status = 'paid')`：仅汇总指定状态；订单数按记录计，商品数按 `quantity` 计，金额为单价分乘数量。
- `byCustomer` 按客户名称汇总订单数、商品数和金额。
- 免费订单计入订单数和商品数。
- `--status pending` 选择待付款订单。
- `--out "待付款 报告.json"` 将结果保存为 UTF-8 JSON；省略时写到标准输出。

验证命令：

```bash
node --test report.test.mjs
```

默认样例汇总为 3 笔已支付订单、6 件商品、2500 分；待付款汇总为 1 笔、2 件、5000 分。
