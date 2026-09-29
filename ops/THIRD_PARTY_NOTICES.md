# Async Subagent 运行与构建依赖

> 职责：记录 Async Subagent 生产 bundle、控制仓 CLI 与构建链的第三方依赖及许可证入口。
> 真源：直接依赖说明；实际入 bundle 的包清单以 `dist/subagent_service.licenses.json` 为准。
> 读取：维护读取

生产 bundle 直接依赖：

- `@modelcontextprotocol/sdk` 1.29.0，MIT License，来源：<https://github.com/modelcontextprotocol/typescript-sdk>
- `zod` 3.25.76，MIT License，来源：<https://github.com/colinhacks/zod>

控制仓 CLI 运行依赖：

- `smol-toml` 1.4.2，MIT License，来源：<https://github.com/squirrelchat/smol-toml>。handoff checker bundle 同时包含该解析器。
- `koffi` 3.2.1，MIT License，来源：<https://koffi.dev/>。Fleet 调度器直接从控制仓加载；npm 按平台安装 `@koromix/koffi-*` 原生包。Pi/MCP 发布槽不运行 Fleet 实现，故不复制该依赖；在控制仓执行 `npm ci --prefix ops`，保留 optionalDependencies。

构建工具：

- `esbuild` 0.28.1，MIT License，来源：<https://github.com/evanw/esbuild>

## 改编源码

`ops/tools/pi_child_bash_process_tree.mjs` 的 `waitForChildProcess` 对齐并改编自 Pi 0.85.1，来源：<https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/utils/child-process.ts>。该声明随发行许可证文件保留。

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 发行清单

每次构建根据 esbuild metafile 生成 `dist/subagent_service.licenses.json`。该文件列出实际进入 server、runner 与 checker 等 bundle 的包名、版本和许可证，是发布产物的依赖清单真源。`dist/THIRD_PARTY_LICENSES.txt` 汇总这些包及构建工具的完整许可证文本，并随不可变发布目录一起部署。
