// 每轮注入 UTC+8 当前日期；时间表达规则由 global-style.md 维护。
// 同一天输出保持稳定，精确时刻由模型按风格规则现场获取。
export default function localTimeExtension(pi) {
  pi.on("before_agent_start", async (event) => {
    const now = new Date();
    const date = now.toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    const block = [
      "<time-discipline>",
      `今日日期: ${date} (UTC+8)。`,
      "</time-discipline>",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
