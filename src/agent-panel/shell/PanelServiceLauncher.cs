using System.Diagnostics;
using System.Text.Json;

namespace AgentPanel.Shell;

public sealed class PanelServiceReady
{
    public required Uri ResolvedLoopbackUrl { get; init; }

    public required int ProcessId { get; init; }

    public required string Signal { get; init; }
}

public sealed class PanelServiceUnavailableException : Exception
{
    public PanelServiceUnavailableException(string message)
        : base(message)
    {
    }

    public PanelServiceUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

// 壳与 Node 服务共享的契约常量：附着前必须确认端口上的服务说的是同一套契约。
public static class PanelServiceContract
{
    public const string Version = "async-task-service/v1";
}

public sealed class PanelServiceLauncher : IAsyncDisposable
{
    private readonly PanelRuntimeOptions _options;
    private readonly HttpClient _httpClient;
    private readonly object _stateLock = new();
    private PanelOwnedProcess? _ownedProcess;
    private Process? _startedProcess;
    private Uri? _reportedUrl;
    private Exception? _readinessProtocolError;
    private bool _stopping;
    private bool _disposed;
    private int _consecutiveHealthFailures;
    private bool _everHealthy;
    private string? _lastHealthProbe;

    // 服务端已将 health 与聚合扫描隔离；750ms 仍用于识别真实的连接/进程故障。
    // 已就绪连接的单次传输抖动可宽限，连续第二次失败才判死；readiness 不走宽限。
    private const int HealthFailureThreshold = 2;

    public PanelServiceLauncher(PanelRuntimeOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _httpClient = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromMilliseconds(750),
        };
    }

    public event EventHandler? ServiceExited;

    private bool _attachedMode;
    private string? _attachedControlRepositoryPath;

    public Uri ResolvedLoopbackUrl => _options.ResolvedLoopbackUrl;

    public bool IsOwnedServiceRunning => _ownedProcess?.IsRunning == true;

    // 附着模式没有 owned process：壳的健康 tick 靠这个标记区分「附着中」与「服务缺位」
    public bool IsAttached
    {
        get
        {
            lock (_stateLock)
            {
                return _attachedMode;
            }
        }
    }

    // 最近一次健康探测的诊断快照（结论 + 耗时），供全局阻断页展示
    public string? LastHealthProbe
    {
        get
        {
            lock (_stateLock)
            {
                return _lastHealthProbe;
            }
        }
    }

    // 附着服务的当前监控仓（可随面板切仓变化，仅作展示，不作身份）
    public string? AttachedControlRepositoryPath
    {
        get
        {
            lock (_stateLock)
            {
                return _attachedControlRepositoryPath;
            }
        }
    }

    public async Task<PanelServiceReady> StartAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();

        // 端口是多方共享的固定单例（派发自动拉起、开发预览、壳自身都会起服务）。
        // 无条件自起会与已有服务抢端口：bind 失败 -> readiness 失败 -> 「服务不可用」
        // 循环重试，占用者不退壳永远起不来（实测反复触发）。先探测同仓健康服务并附着。
        var attached = await TryAttachAsync(cancellationToken).ConfigureAwait(false);
        if (attached is not null)
        {
            return attached;
        }

        PanelOwnedProcess? exitedProcess = null;
        lock (_stateLock)
        {
            if (_startedProcess is not null)
            {
                if (_ownedProcess?.IsRunning == true)
                {
                    throw new InvalidOperationException("panel-owned service 已经启动。");
                }

                exitedProcess = _ownedProcess;
                _ownedProcess = null;
                _startedProcess = null;
            }

            _stopping = false;
            _reportedUrl = null;
            _readinessProtocolError = null;
            // 上一段生命周期的健康史不带进新进程：readiness 本身已走无宽限的
            // ProbeHealthAsync，这里的复位保证的是 StartAsync 失败后的下一个
            // steady-state tick 不继承旧宽限（opus 复核 F9，二轮 R2-04 口径修正）。
            // 诊断快照一并清空，阻断页不得展示上一段的「健康检查通过」（二轮 R2-02）。
            _everHealthy = false;
            _consecutiveHealthFailures = 0;
            _lastHealthProbe = null;
        }

        if (exitedProcess is not null)
        {
            await exitedProcess.DisposeAsync().ConfigureAwait(false);
        }

        ValidateLaunchPaths();
        var startInfo = PanelServiceCommand.CreateStartInfo(_options, Environment.ProcessId);
        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        process.OutputDataReceived += OnOutputDataReceived;
        // 每次启动独立缓存，正常运行不落盘；EOF 保证崩溃末尾的诊断已读完。
        var stderrTail = new Queue<string>();
        var stderrClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        process.ErrorDataReceived += (_, args) =>
        {
            if (args.Data is null)
            {
                stderrClosed.TrySetResult();
                return;
            }
            lock (stderrTail)
            {
                stderrTail.Enqueue(args.Data);
                while (stderrTail.Count > 50) stderrTail.Dequeue();
            }
        };
        process.Exited += async (sender, args) =>
        {
            bool unexpected;
            lock (_stateLock) unexpected = !_stopping;
            await stderrClosed.Task.ConfigureAwait(false);
            if (unexpected)
            {
                try
                {
                    var logDirectory = Path.Combine(_options.PanelStateRoot, "logs");
                    Directory.CreateDirectory(logDirectory);
                    string[] lines;
                    lock (stderrTail) lines = stderrTail.ToArray();
                    File.WriteAllLines(Path.Combine(logDirectory, "service-crash.log"),
                        new[] { $"{DateTimeOffset.UtcNow:O} panel-owned service unexpectedly exited; stderr tail (max 50 lines):" }
                            .Concat(lines));
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    lock (_stateLock) _lastHealthProbe = $"服务崩溃诊断写入失败：{exception.Message}";
                }
            }
            OnProcessExited(sender, args);
        };

        try
        {
            if (!process.Start())
            {
                throw new PanelServiceUnavailableException("panel-owned service 启动失败。");
            }

            lock (_stateLock)
            {
                _startedProcess = process;
                _ownedProcess = new PanelOwnedProcess(process);
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var signal = await WaitForReadinessAsync(process, cancellationToken).ConfigureAwait(false);
            return new PanelServiceReady
            {
                ResolvedLoopbackUrl = _options.ResolvedLoopbackUrl,
                ProcessId = process.Id,
                Signal = signal,
            };
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await StopAsync().ConfigureAwait(false);
            throw;
        }
        catch (Exception exception) when (exception is not PanelServiceUnavailableException)
        {
            await StopAsync().ConfigureAwait(false);
            throw new PanelServiceUnavailableException("panel-owned service 未通过 loopback readiness 检查。", exception);
        }
        catch
        {
            await StopAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<PanelServiceReady?> TryAttachAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _httpClient.GetAsync(
                new Uri(_options.ResolvedLoopbackUrl, "api/health"),
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if ((int)response.StatusCode is < 200 or >= 300)
            {
                return null;
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!MatchesExpectedIdentity(body)) return null;
            using var document = JsonDocument.Parse(body);
            TryReadString(document.RootElement, "resolved_loopback_url", out var reportedUrlText);
            TryReadString(document.RootElement, "control_repo_path", out var attachedControlRepository);
            var attachedControlRepositoryPath = string.IsNullOrWhiteSpace(attachedControlRepository)
                ? null
                : attachedControlRepository;
            lock (_stateLock)
            {
                _attachedMode = true;
                _attachedControlRepositoryPath = attachedControlRepositoryPath;
            }

            RecordHealthSuccess(0, attachedControlRepositoryPath is null
                ? "附着既有面板服务"
                : $"附着既有面板服务（当前监控仓 {attachedControlRepositoryPath}）");
            RecordReportedUrl(reportedUrlText);
            return new PanelServiceReady
            {
                ResolvedLoopbackUrl = _options.ResolvedLoopbackUrl,
                ProcessId = 0,
                Signal = "attached-existing-service",
            };
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            // 附着是机会主义：探不到、超时、响应不合法都回落到自起路径
            return null;
        }
    }

    private static bool TryReadString(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty(propertyName, out var property)
            || property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = property.GetString() ?? string.Empty;
        return value.Length > 0;
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        bool attachedMode;
        lock (_stateLock)
        {
            attachedMode = _attachedMode;
        }

        if (!IsOwnedServiceRunning && !attachedMode)
        {
            // 不探测直接判不健康的路径也要写快照，否则阻断页会展示上一次
            // 「健康检查通过」的陈旧文案，自相矛盾（opus 复核 F10）
            lock (_stateLock)
            {
                _lastHealthProbe = "服务缺位：无 panel-owned 进程且未附着";
            }

            return false;
        }

        var (ok, failureDetail, identityMatches) = await ProbeHealthAsync(cancellationToken).ConfigureAwait(false);
        return ok ? identityMatches : RecordHealthFailure(failureDetail!);
    }

    // 原始健康探测：不做宽限记账。readiness 直接用它——宽限只属于已就绪后的
    // steady state，readiness 轮内任何一次 health 失败都必须如实为假（sol 复核 F-07：
    // 曾成功置位 _everHealthy 后，同一 readiness 循环的后续失败曾被宽限成 true）。
    // IdentityMatches：端口上的服务必须自报同一面板资产根（panel_root）与契约，否则不是本壳的实例。
    private async Task<(bool Ok, string? FailureDetail, bool IdentityMatches)> ProbeHealthAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            using var response = await _httpClient.GetAsync(
                new Uri(_options.ResolvedLoopbackUrl, "api/health"),
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if ((int)response.StatusCode is < 200 or >= 300)
            {
                return (false, $"health 返回 {(int)response.StatusCode}，耗时 {stopwatch.ElapsedMilliseconds} ms", false);
            }

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            TryRecordHealthUrl(body);
            var identityMatches = MatchesExpectedIdentity(body);
            if (identityMatches)
            {
                RecordHealthSuccess(stopwatch.ElapsedMilliseconds);
            }
            else
            {
                lock (_stateLock)
                {
                    _attachedMode = false;
                    _attachedControlRepositoryPath = null;
                    _lastHealthProbe = "health 可达但服务身份不是本面板资产根";
                }
            }
            return (true, null, identityMatches);
        }
        catch (HttpRequestException exception)
        {
            return (false, $"连接失败（{exception.Message}），耗时 {stopwatch.ElapsedMilliseconds} ms", false);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (false, $"超过 {_httpClient.Timeout.TotalMilliseconds:F0} ms 未响应", false);
        }
    }

    // 稳定实例身份：稳定面板资产根（panel_root）+ 契约版本。监控仓（control_repo_path）会随切仓变化，不参与。
    private bool MatchesExpectedIdentity(string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            if (!TryReadString(document.RootElement, "panel_root", out var reportedPanelRoot)
                || !string.Equals(
                    NormalizeRoot(reportedPanelRoot),
                    NormalizeRoot(_options.RepositoryRoot),
                    StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return document.RootElement.TryGetProperty("ok", out var ok)
                && ok.ValueKind == JsonValueKind.True
                && TryReadString(document.RootElement, "contract_version", out var reportedContract)
                && string.Equals(reportedContract, PanelServiceContract.Version, StringComparison.Ordinal)
                && TryReadString(document.RootElement, "resolved_loopback_url", out var reportedUrlText)
                && Uri.TryCreate(reportedUrlText, UriKind.Absolute, out var reportedUrl)
                && LoopbackEndpoint.IsLockedRoot(reportedUrl, _options.ResolvedLoopbackUrl);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string NormalizeRoot(string value)
    {
        var full = Path.GetFullPath(value);
        return full.Length > 3
            ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            : full;
    }

    // 曾健康过的连接才享受瞬态宽限；readiness 阶段（从未健康）失败立即为假，
    // 避免探测尚未就绪的服务被宽限成「已就绪」。判死时同步释放附着。
    private bool RecordHealthFailure(string detail)
    {
        lock (_stateLock)
        {
            _consecutiveHealthFailures += 1;
            _lastHealthProbe = $"健康检查失败×{_consecutiveHealthFailures}：{detail}";
            if (_everHealthy && _consecutiveHealthFailures < HealthFailureThreshold)
            {
                return true;
            }

            _attachedMode = false;
            _attachedControlRepositoryPath = null;
            return false;
        }
    }

    private void RecordHealthSuccess(long elapsedMilliseconds, string? detail = null)
    {
        lock (_stateLock)
        {
            _consecutiveHealthFailures = 0;
            _everHealthy = true;
            _lastHealthProbe = detail is null
                ? $"健康检查通过，耗时 {elapsedMilliseconds} ms"
                : $"{detail}，耗时 {elapsedMilliseconds} ms";
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        PanelOwnedProcess? ownedProcess;
        lock (_stateLock)
        {
            if (_startedProcess is null && _ownedProcess is null)
            {
                return;
            }

            // readiness 发现进程已崩后也会调用 StopAsync；不能把这次崩溃误标为主动停止。
            _stopping = _startedProcess?.HasExited != true;
            ownedProcess = _ownedProcess;
            _ownedProcess = null;
            _startedProcess = null;
        }

        if (ownedProcess is not null)
        {
            await ownedProcess.StopAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        await StopAsync().ConfigureAwait(false);
        _httpClient.Dispose();
    }

    private async Task<string> WaitForReadinessAsync(Process process, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_options.ReadinessTimeout);

        while (true)
        {
            timeout.Token.ThrowIfCancellationRequested();
            if (process.HasExited)
            {
                throw new PanelServiceUnavailableException("panel-owned service 在 readiness 前退出。");
            }

            Exception? protocolError;
            Uri? reportedUrl;
            lock (_stateLock)
            {
                protocolError = _readinessProtocolError;
                reportedUrl = _reportedUrl;
            }

            if (protocolError is not null)
            {
                throw new PanelServiceUnavailableException("service readiness 返回了非法 loopback URL。", protocolError);
            }

            if (reportedUrl is not null && !LoopbackEndpoint.IsLockedRoot(reportedUrl, _options.ResolvedLoopbackUrl))
            {
                throw new PanelServiceUnavailableException(
                    $"service readiness URL 未锁定到 {_options.ResolvedLoopbackUrl.AbsoluteUri}。");
            }

            var probe = await ProbeHealthAsync(timeout.Token).ConfigureAwait(false);
            if (!probe.Ok)
            {
                // readiness 失败也要留诊断快照：超时抛出后阻断页引用它（opus 二轮 R2-02）
                lock (_stateLock)
                {
                    _lastHealthProbe = $"readiness 探测失败：{probe.FailureDetail}";
                }
            }
            else if (!probe.IdentityMatches)
            {
                // 端口被别的面板资产根占用：自起进程 bind 失败退出前的探测可能命中占用者，
                // 不能凭 health 200 就宣布就绪（否则跨仓/异根服务会被误认成自己的服务）。
                lock (_stateLock)
                {
                    _lastHealthProbe = "readiness 探测到不同面板资产根或契约的服务";
                }
            }

            if (probe.Ok
                && probe.IdentityMatches
                && await IsRootReachableAsync(timeout.Token).ConfigureAwait(false))
            {
                Exception? updatedProtocolError;
                lock (_stateLock)
                {
                    updatedProtocolError = _readinessProtocolError;
                    reportedUrl = _reportedUrl;
                }

                if (updatedProtocolError is not null)
                {
                    throw new PanelServiceUnavailableException("service readiness 返回了非法 loopback URL。", updatedProtocolError);
                }

                if (reportedUrl is null)
                {
                    await Task.Delay(_options.ReadinessPollInterval, timeout.Token).ConfigureAwait(false);
                    continue;
                }

                if (!LoopbackEndpoint.IsLockedRoot(reportedUrl, _options.ResolvedLoopbackUrl))
                {
                    throw new PanelServiceUnavailableException(
                        $"service readiness URL 未锁定到 {_options.ResolvedLoopbackUrl.AbsoluteUri}。");
                }

                return "service-readiness+http-root-probe";
            }

            await Task.Delay(_options.ReadinessPollInterval, timeout.Token).ConfigureAwait(false);
        }
    }

    private async Task<bool> IsRootReachableAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _httpClient.GetAsync(
                _options.ResolvedLoopbackUrl,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            return (int)response.StatusCode is >= 200 and < 300;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    private void ValidateLaunchPaths()
    {
        if (!Directory.Exists(_options.RepositoryRoot))
        {
            throw new PanelServiceUnavailableException($"面板仓路径不存在：{_options.RepositoryRoot}。");
        }

        if (!Directory.Exists(_options.ControlRepositoryPath))
        {
            throw new PanelServiceUnavailableException($"控制仓路径不存在：{_options.ControlRepositoryPath}。");
        }

        var entryPoint = Path.GetFullPath(Path.Combine(_options.RepositoryRoot, _options.ServiceEntryPoint));
        if (!File.Exists(entryPoint))
        {
            throw new PanelServiceUnavailableException($"loopback 服务入口不存在：{entryPoint}。");
        }
    }

    private void OnOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
    {
        if (string.IsNullOrWhiteSpace(eventArgs.Data))
        {
            return;
        }

        if (!TryExtractResolvedUrl(eventArgs.Data, out var urlText))
        {
            return;
        }

        RecordReportedUrl(urlText);
    }

    private void OnProcessExited(object? sender, EventArgs eventArgs)
    {
        var unexpectedExit = false;
        PanelOwnedProcess? exitedProcess = null;
        lock (_stateLock)
        {
            // stderr 排空期间可能已停止或重启，旧进程回调不能清掉新进程的所有权。
            if (!ReferenceEquals(sender, _startedProcess)) return;
            unexpectedExit = !_stopping;
            if (unexpectedExit)
            {
                exitedProcess = _ownedProcess;
                _ownedProcess = null;
                _startedProcess = null;
                _lastHealthProbe = "panel-owned 服务进程意外退出";
            }
        }

        if (exitedProcess is not null)
        {
            _ = exitedProcess.DisposeAsync().AsTask();
        }

        if (unexpectedExit)
        {
            ServiceExited?.Invoke(this, EventArgs.Empty);
        }
    }

    private static bool TryExtractResolvedUrl(string line, out string? urlText)
    {
        const string key = "resolved_loopback_url";
        urlText = null;
        var markerIndex = line.IndexOf(key, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0)
        {
            return false;
        }

        var remainder = line[(markerIndex + key.Length)..].TrimStart();
        if (remainder.StartsWith('=') || remainder.StartsWith(':'))
        {
            urlText = remainder[1..].Trim().Trim('"', '\'').TrimEnd(',', '}');
            return urlText.Length > 0;
        }

        if (!line.TrimStart().StartsWith('{'))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(line);
            if (document.RootElement.TryGetProperty(key, out var property)
                && property.ValueKind == JsonValueKind.String)
            {
                urlText = property.GetString();
                return !string.IsNullOrWhiteSpace(urlText);
            }
        }
        catch (JsonException)
        {
            // The service may print ordinary diagnostics containing the marker.
        }

        return false;
    }

    private void TryRecordHealthUrl(string body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.TryGetProperty("resolved_loopback_url", out var property)
                && property.ValueKind == JsonValueKind.String)
            {
                RecordReportedUrl(property.GetString());
            }
        }
        catch (JsonException)
        {
            // Readiness remains pending until a valid resolved_loopback_url is observed.
        }
    }

    private void RecordReportedUrl(string? urlText)
    {
        if (string.IsNullOrWhiteSpace(urlText))
        {
            return;
        }

        if (!Uri.TryCreate(urlText, UriKind.Absolute, out var url))
        {
            lock (_stateLock)
            {
                _readinessProtocolError = new FormatException("resolved_loopback_url 不是有效 URL。");
            }

            return;
        }

        lock (_stateLock)
        {
            _reportedUrl = url;
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(PanelServiceLauncher));
        }
    }
}
