using System.Diagnostics;
using System.Globalization;

namespace AgentPanel.Shell;

public static class PanelServiceCommand
{
    public static ProcessStartInfo CreateStartInfo(PanelRuntimeOptions options, int parentProcessId)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (parentProcessId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(parentProcessId));
        }

        var entryPoint = Path.GetFullPath(Path.Combine(options.RepositoryRoot, options.ServiceEntryPoint));
        var startInfo = new ProcessStartInfo
        {
            FileName = options.NodeExecutable,
            WorkingDirectory = options.RepositoryRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };

        startInfo.ArgumentList.Add(entryPoint);
        AddArgument(startInfo, "--control-root", options.ControlRepositoryPath);
        AddArgument(startInfo, "--host", LoopbackEndpoint.Host);
        AddArgument(startInfo, "--port", options.Port.ToString(CultureInfo.InvariantCulture));
        AddArgument(startInfo, "--parent-pid", parentProcessId.ToString(CultureInfo.InvariantCulture));

        startInfo.Environment["AGENT_PANEL_CONTROL_REPO_PATH"] = options.ControlRepositoryPath;
        startInfo.Environment["AGENT_PANEL_CONTROL_REPO"] = options.ControlRepositoryPath;
        startInfo.Environment["CONTROL_REPO_PATH"] = options.ControlRepositoryPath;
        // 面板资产根是稳定实例身份（panel_root）；壳与 Node 服务必须报到同一个值。
        startInfo.Environment["AGENT_PANEL_PANEL_ROOT"] = options.RepositoryRoot;
        // 日志与 WebView2 缓存统一落用户级面板状态目录，不跟随监控仓切换。
        startInfo.Environment["AGENT_PANEL_STATE_ROOT"] = options.PanelStateRoot;
        startInfo.Environment["AGENT_PANEL_LOOPBACK_URL"] = options.ResolvedLoopbackUrl.AbsoluteUri;
        startInfo.Environment["AGENT_PANEL_HOST"] = LoopbackEndpoint.Host;
        startInfo.Environment["AGENT_PANEL_PORT"] = options.Port.ToString(CultureInfo.InvariantCulture);
        startInfo.Environment["AGENT_PANEL_PARENT_PID"] = parentProcessId.ToString(CultureInfo.InvariantCulture);

        return startInfo;
    }

    private static void AddArgument(ProcessStartInfo startInfo, string name, string value)
    {
        startInfo.ArgumentList.Add(name);
        startInfo.ArgumentList.Add(value);
    }
}
