// 子代理的 grep / find：@tian.zuo/pi-find 以同名注册覆盖 Pi 内置实现（ripgrep / fd 驱动，输出有界）。
// 包只发布 TypeScript 源码且无 main/exports，按入口文件导入；@earendil-works/* 与 typebox 由 Pi 扩展加载器提供。
export { default } from "@tian.zuo/pi-find/index.ts";
