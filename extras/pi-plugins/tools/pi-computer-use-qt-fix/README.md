# pi-computer-use Windows 修正补丁

修正 `@injaneity/pi-computer-use@0.5.1` 的 Windows 原生 helper（`native/windows/bridge-rs`，Rust）与 TypeScript 前端。管理器只接受包版本 0.5.1。

## 补丁

| 层 | 补丁 | 改动对象 | 内容 |
| --- | --- | --- | --- |
| 原生 | `native.patch` | `src/capture.rs`、`main.rs`、`refs.rs`、`uia.rs` | 修正手写的 UIA 控件类型编号；空 RuntimeId 不参与身份匹配（Qt 控件），以 `CompareElements` 判定命中；空身份不再被误报为遮挡 |
| 原生 | `window-root.patch` | `src/main.rs` | 外层窗口节点与其 UIA 根共享观察身份，窗口级输入走同样的前台、可见性与遮挡检查 |
| 原生 | `visual-observation.patch` | `src/main.rs`、`capture.rs` | 目标在前台时用屏幕区域 BitBlt 截图，后台仍用 PrintWindow；alpha 统一不透明；截图不主动激活窗口 |
| 原生 | `focused-input-foreground.patch` | `src/main.rs` | 保持焦点的物理输入发送前核验前台窗口，归属不符时拒发 |
| 前端 | `frontend-focus.patch` | `src/bridge.ts` | 非 headless 事务以操作系统当前焦点为初始焦点，支持跨调用的点击、输入、回车 |
| 前端 | `visual-observation-frontend.patch` | `src/bridge.ts`、`platform/types.ts`、`platform/windows/backend.ts`、`outline.ts` | 视觉观察与纯图片动作后的刷新不提取控件树，沿用原图尺寸；语义模式保留 UIA |

补丁按表中顺序逐层叠加：原生四份依次以前一份打完后的源码为基线，前端两份同样依次叠加，两层互不依赖。`focused-input-foreground.patch`、`visual-observation.patch`、`visual-observation-frontend.patch` 以 CRLF 保存，其余为 LF；改动换行会使补丁哈希与构建记录不符。

## 前提

- `pi install npm:@injaneity/pi-computer-use@0.5.1`。
- Rust 工具链（`cargo`）、Python 与 `psutil`、Git。
- 测试脚本另需 PyQt5（`qt-fixture.py`）与 pywin32（`test-common-apps.py`）。

下文 `<agent>` 指 Pi 的 agent 目录（`PI_CODING_AGENT_DIR`，未设置时 `%USERPROFILE%\.pi\agent`），`$cu` 指 `<agent>\npm\node_modules\@injaneity\pi-computer-use`。`manage-installed.py` 默认使用 `%USERPROFILE%\.pi\agent`，其它 agent 目录用 `--agent-home` 指定。

## 原生 helper

每份原生补丁单独构建一次候选并安装，下一轮以已安装（含前一份补丁）的源码为 `--source`：

```powershell
python -B tools/pi-computer-use-qt-fix/build-candidate.py --source "$cu\native\windows\bridge-rs" --work-dir <新的空目录> --patch tools/pi-computer-use-qt-fix/native.patch
python -B tools/pi-computer-use-qt-fix/manage-installed.py apply --candidate <同一目录> --record <新的记录文件.json> --patch tools/pi-computer-use-qt-fix/native.patch
```

按 `native.patch`、`window-root.patch`、`visual-observation.patch`、`focused-input-foreground.patch` 的顺序重复这两条命令，每轮换新的 `--work-dir` 与 `--record`。两条命令传同一个 `--patch`：`manage-installed.py` 默认按 `native.patch` 核对候选记录中的补丁哈希，后续补丁不传会被拒绝。

`build-candidate.py` 把 crate（不含 `target`、`.git`）复制到 `--work-dir`（须为新目录，且在 agent 目录之外），以 `git -c core.autocrlf=true apply` 应用补丁，再运行 `cargo test` 与 `cargo build --release`，写出 `candidate-build.json`。第一轮把 LF 源码写成 CRLF，后续补丁的上下文按 CRLF 生成，因此换行设置固定在脚本里，不受本机 Git 配置影响。在原版 0.5.1 源码上按上述顺序应用四份补丁，结果与维护者部署的源码逐字节一致。

`manage-installed.py apply --candidate` 核对包版本、补丁哈希、已安装源码与候选记录的基线及候选二进制哈希，备份到 `<agent>\state\deploy\pi-computer-use-qt-<时间>\`，结束路径为 `<agent>\helpers\pi-computer-use\windows-bridge.exe` 的运行中 helper，替换已安装源码与包内 `prebuilt\windows\windows-bridge.exe`，再调用包内 `scripts/setup-helper.mjs` 安装运行时 helper；不改 `settings.json`。`--record` 必须是新路径。完成后重启持有 helper 的宿主进程。

## 前端

```powershell
python -B tools/pi-computer-use-qt-fix/build-frontend-candidate.py --package $cu --work-dir <新的空目录>
python -B tools/pi-computer-use-qt-fix/manage-installed.py apply --frontend-candidate <同一目录> --record <新的记录文件.json>
```

`build-frontend-candidate.py` 只复制补丁涉及的文件，依次应用 `frontend-focus.patch` 与 `visual-observation-frontend.patch`（`--patch` 可重复，按给出的顺序替换默认列表；CRLF 补丁按 LF 应用，与包内 LF 源码一致），写出 `frontend-build.json`：

```json
{
  "sourceHashes": { "<相对路径>": "<已安装文件 SHA-256>" },
  "candidateHashes": { "<相对路径>": "<候选文件 SHA-256>" }
}
```

两份前端补丁以原版 0.5.1 为基线，已打过补丁的安装上 `git apply` 失败。`manage-installed.py apply --frontend-candidate` 核对两组哈希、备份后只替换清单中的文件，不结束 helper；新会话生效。

## 状态与回滚

```powershell
python -B tools/pi-computer-use-qt-fix/manage-installed.py status --record <记录文件>
python -B tools/pi-computer-use-qt-fix/manage-installed.py rollback --record <记录文件>
```

`status` 在记录中的文件全部处于期望状态时退出 0，并报告 `settings.json` 自安装后是否未变。`rollback` 只接受处于该记录安装前或安装后状态的文件，因此多份记录按安装的逆序逐份回滚。

## 测试

```powershell
node --test tests/pi/computer_use_focused_input.test.mjs tests/pi/computer_use_visual_observation.test.mjs
python -B tools/pi-computer-use-qt-fix/test-isolated.py --helper <exe> --fixture-python <带 PyQt5 的 python> --output <目录>
python -B tools/pi-computer-use-qt-fix/test-capture-isolated.py --helper <exe> --output <目录>
```

两个 Node 测试默认读取 `%USERPROFILE%\.pi\agent` 下的已安装包，`CU_CANDIDATE_DIR` 可指向候选包。`test-isolated.py` 只操作自行启动的 PyQt5 夹具窗口，`--baseline`、`--window-root` 选择对照组；`test-capture-isolated.py` 用两个自建 Win32 窗口检查截图来源。`test-common-apps.py --helper <exe> --output <目录> --software ...` 操作 AutoCAD 2027、记事本与资源管理器，其中第 116 行的 AutoCAD 模板路径与第 113 行的 COM 名 `AutoCAD.Application.26` 按维护者本机写死。

## 维护

npm 重装或更新覆盖全部改动，helper 二进制会被包内 prebuilt 还原；之后按本说明重新构建安装。`manage-installed.py` 会结束运行中的 helper 进程。
