# paste-image

把剪贴板图片插入 Pi 输入框。宿主从 `extensions/` 自动加载此文件，不读取 `settings.packages`。

## 包含

- `paste-image.ts`：注册 `/img`。
- `status.mjs`：只读比对安装副本哈希。

## 不包含

- 不改 `settings.json`。
- 不写入用户目录。安装由维护者复制文件完成。

## 命令

截图（Win+Shift+S，或微信 Alt+A）后，在 Pi 输入 `/img` 并回车。扩展把剪贴板图片存为临时 PNG，并把路径写入输入框。再回车发送。剪贴板没有图片时只提示，输入框保持原样。

## 安装位置

复制 `paste-image.ts` 到用户 Pi agent 目录（设置了 `PI_CODING_AGENT_DIR` 时为该目录，`status.mjs` 同样按它查找）：

```text
%USERPROFILE%\.pi\agent\extensions\paste-image.ts
```

已有会话需 `/reload` 或重启后加载新文件。本目录是插件仓源码；`status.mjs` 不复制、不覆盖安装副本。

## 验收

```bash
node tools/pi-paste-image/status.mjs
```

源与安装副本 sha256 一致时退出码 0，并打印 `PASTE_IMAGE_OK`。缺失或不一致时退出码 1，只打印两边哈希。
