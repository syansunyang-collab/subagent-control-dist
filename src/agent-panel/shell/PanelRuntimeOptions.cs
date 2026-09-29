using System.Globalization;

namespace AgentPanel.Shell;

public sealed record PanelRuntimeOptions
{
    public required string RepositoryRoot { get; init; }

    public required string ControlRepositoryPath { get; init; }

    public required string NodeExecutable { get; init; }

    public required string ServiceEntryPoint { get; init; }

    public required Uri ResolvedLoopbackUrl { get; init; }

    // 用户级面板状态目录（日志、WebView2 缓存）：不落在生产者仓，也不落在消费项目目录。
    public required string PanelStateRoot { get; init; }

    public TimeSpan ReadinessTimeout { get; init; } = TimeSpan.FromSeconds(20);

    public TimeSpan ReadinessPollInterval { get; init; } = TimeSpan.FromMilliseconds(250);

    public int Port => ResolvedLoopbackUrl.Port;

    public static PanelRuntimeOptions Parse(IReadOnlyList<string> args)
    {
        var values = ParseArguments(args);
        var repositoryRoot = ResolvePath(
            GetValue(values, "repository-root")
                ?? Environment.GetEnvironmentVariable("AGENT_PANEL_REPOSITORY_ROOT")
                ?? DiscoverRepositoryRoot());
        // 默认控制仓为面板模块（<仓根>/src/agent-panel）上两级，即所属仓根。
        var controlRepositoryPath = ResolvePath(
            GetValue(values, "control-repo")
                ?? Environment.GetEnvironmentVariable("AGENT_PANEL_CONTROL_REPO")
                ?? Path.Combine(repositoryRoot, "..", ".."));
        var expectedUrl = LoopbackEndpoint.ForRepository(repositoryRoot);

        if (values.TryGetValue("port", out var portText))
        {
            if (!int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var requestedPort)
                || requestedPort != expectedUrl.Port)
            {
                throw new ArgumentException(
                    $"端口必须由仓路径派生，{repositoryRoot} 对应端口为 {expectedUrl.Port}。",
                    nameof(args));
            }
        }

        if (values.TryGetValue("loopback-url", out var suppliedUrlText))
        {
            if (!Uri.TryCreate(suppliedUrlText, UriKind.Absolute, out var suppliedUrl)
                || !LoopbackEndpoint.IsLockedRoot(suppliedUrl, expectedUrl))
            {
                throw new ArgumentException(
                    $"loopback URL 必须精确指向 {expectedUrl.AbsoluteUri}。",
                    nameof(args));
            }
        }

        var readinessTimeout = ParseSeconds(values, "readiness-timeout-seconds", 20);
        if (readinessTimeout <= 0)
        {
            throw new ArgumentException("readiness 超时必须大于 0 秒。", nameof(args));
        }

        return new PanelRuntimeOptions
        {
            RepositoryRoot = repositoryRoot,
            ControlRepositoryPath = controlRepositoryPath,
            NodeExecutable = GetValue(values, "node")
                ?? Environment.GetEnvironmentVariable("AGENT_PANEL_NODE")
                ?? "node",
            ServiceEntryPoint = GetValue(values, "service-entry") ?? "src/server/index.mjs",
            ResolvedLoopbackUrl = expectedUrl,
            PanelStateRoot = ResolvePanelStateRoot(),
            ReadinessTimeout = TimeSpan.FromSeconds(readinessTimeout),
            ReadinessPollInterval = TimeSpan.FromMilliseconds(250),
        };
    }

    // 与 Node 服务同源：AGENT_PANEL_STATE_ROOT 优先，默认 ~/.subagent-control/agent-panel。
    public static string ResolvePanelStateRoot()
    {
        var explicitRoot = Environment.GetEnvironmentVariable("AGENT_PANEL_STATE_ROOT");
        if (!string.IsNullOrWhiteSpace(explicitRoot))
        {
            return Path.GetFullPath(explicitRoot);
        }

        return Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".subagent-control",
            "agent-panel"));
    }

    public static string DiscoverRepositoryRoot()
    {
        var candidates = new[]
        {
            Directory.GetCurrentDirectory(),
            AppContext.BaseDirectory,
        };

        foreach (var candidate in candidates)
        {
            var current = new DirectoryInfo(Path.GetFullPath(candidate));
            while (current is not null)
            {
                if (File.Exists(Path.Combine(current.FullName, "package.json"))
                    || Directory.Exists(Path.Combine(current.FullName, "src"))
                    || Directory.Exists(Path.Combine(current.FullName, "shell")))
                {
                    return current.FullName;
                }

                current = current.Parent;
            }
        }

        return Path.GetFullPath(Directory.GetCurrentDirectory());
    }

    private static Dictionary<string, string> ParseArguments(IReadOnlyList<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Count; index++)
        {
            var argument = args[index];
            if (!argument.StartsWith("--", StringComparison.Ordinal) || argument.Length <= 2)
            {
                throw new ArgumentException($"无法识别的启动参数：{argument}。", nameof(args));
            }

            var key = argument[2..];
            if (key is "help" or "h")
            {
                throw new ArgumentException("请使用 README 中列出的启动参数。", nameof(args));
            }

            if (index + 1 >= args.Count || args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"启动参数缺少值：{argument}。", nameof(args));
            }

            values[key] = args[++index];
        }

        return values;
    }

    private static string? GetValue(IReadOnlyDictionary<string, string> values, string key)
    {
        return values.TryGetValue(key, out var value) ? value : null;
    }

    private static int ParseSeconds(
        IReadOnlyDictionary<string, string> values,
        string key,
        int defaultValue)
    {
        var value = GetValue(values, key);
        return value is null
            ? defaultValue
            : int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
                ? seconds
                : throw new ArgumentException($"参数 --{key} 必须是整数秒。", nameof(values));
    }

    private static string ResolvePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("路径不能为空。", nameof(path));
        }

        return Path.GetFullPath(path);
    }
}
