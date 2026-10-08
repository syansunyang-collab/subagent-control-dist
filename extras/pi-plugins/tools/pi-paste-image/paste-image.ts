// /img —— 把剪贴板里的截图贴进输入框（不依赖 Alt+V 键位投递）
// 原理：PowerShell 读 Windows 剪贴板图片 → 存 %TEMP%\pi-clipboard-<uuid>.png → 路径插入编辑器。
// 用法：Win+Shift+S 或微信 Alt+A 截图后，输入 /img 回车，路径进输入框，再回车发送。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function (pi) {
  pi.registerCommand("img", {
    description: "粘贴剪贴板图片到输入框（截图后直接 /img，无需 Alt+V）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        `$path = '${filePath.replaceAll("'", "''")}'`,
        "$img = [System.Windows.Forms.Clipboard]::GetImage()",
        "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
      ].join("; ");
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], {
        encoding: "utf-8",
        timeout: 8000,
      });
      const ok = result.status === 0
        && String(result.stdout || "").trim() === "ok"
        && existsSync(filePath)
        && statSync(filePath).size > 0;
      if (!ok) {
        ctx.ui.notify("剪贴板里没有图片。先截图（Win+Shift+S / 微信 Alt+A），再输 /img。", "warning");
        return;
      }
      const current = ctx.ui.getEditorText?.() ?? "";
      ctx.ui.setEditorText(current ? `${current} ${filePath}` : filePath);
      ctx.ui.notify(`图片已就绪：${filePath}（直接回车发送）`, "info");
    },
  });
}
