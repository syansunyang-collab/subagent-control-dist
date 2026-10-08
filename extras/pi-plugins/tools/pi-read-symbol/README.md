# pi-read-symbol

Pi 工具 `read_symbol`：按名字读出完整定义（函数、方法、类、结构体、枚举、trait、impl 块、接口、类型别名），附起止行号；只给文件路径时列出该文件全部定义及行号范围。底层调用 ast-grep 按语法树节点匹配，支持 Rust、Python、TypeScript/TSX、JavaScript、Go。

前置条件：`ast-grep` 在 PATH 上（`winget install ast-grep.ast-grep`，本机 0.45.1），或用环境变量 `AST_GREP_BIN` 指定可执行文件。

## 参数与返回

| 参数 | 说明 |
|---|---|
| `path` | 文件；给了 `name` 时也可以是目录（遵循 `.gitignore`） |
| `name` | 定义名，可写成 `Type::method` 或 `Class.method` 以区分同名定义；省略则返回文件大纲 |

- 按名读取：每个匹配返回 `路径:起-止` 与原文（保留缩进）。所属的装饰器、Rust `#[...]` 外部属性和 `///` 文档注释一并返回；归属与范围由 ast-grep 语法节点确定，多行参数中的字符串与块注释保留，装饰器/属性之间以及到定义之间的空行保留。普通注释不作为向上附加内容，Rust `#![...]` 内部属性随其所在定义正文返回。最多 8 个匹配，其余只列位置；单个定义超过 400 行时截断并给出续读的 `read` 偏移。
- 大纲：按行号列出定义，嵌套的定义缩进一级；TS/JS 只列值为函数或类的变量声明。
- 找不到名字时返回该文件大纲；不支持的文件类型提示改用 `read`。

## 安装

`~/.pi/agent/local-packages/pi-read-symbol` 为指向本目录的目录链接，全局 `settings.json` 的 `packages` 登记该路径。Pi 直接加载 `src/index.ts`，无需构建；`@sinclair/typebox` 与 `@earendil-works/pi-*` 由 Pi 提供。

## 测试

```bash
npm test
```

`test/*.test.mjs` 使用 `test/fixtures/` 与测试内构造的样例覆盖：限定名选中指定 impl / 类中的方法、装饰器与属性随定义返回（含多行、空行隔开、三引号字符串、块注释和超过 80 行的装饰器），跨定义文档字符串与属性不误归属、接口与重载签名、TS 箭头函数常量、Go 方法与类型、找不到时返回大纲、目录搜索、超长定义截断。
