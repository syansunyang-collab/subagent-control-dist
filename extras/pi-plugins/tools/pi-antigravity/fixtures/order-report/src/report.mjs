import { toCents } from './money.mjs';

export function summarize(orders, status = 'paid') {
  const result = { orderCount: 0, itemCount: 0, totalCents: 0, byCustomer: {} };
  for (const order of orders) {
    if (order.status === 'cancelled' || !order.unitPrice) continue;
    const amount = toCents(order.unitPrice);
    const group = result.byCustomer[order.customer] ??= { orders: 0, items: 0, totalCents: 0 };
    result.orderCount += 1;
    result.itemCount += 1;
    result.totalCents += amount;
    group.orders += 1;
    group.items += 1;
    group.totalCents += amount;
  }
  return result;
}
