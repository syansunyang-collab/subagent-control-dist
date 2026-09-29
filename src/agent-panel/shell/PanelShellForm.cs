using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AgentPanel.Shell;

public sealed class PanelShellForm : Form
{
    private readonly PanelRuntimeOptions _options;
    private readonly PanelServiceLauncher _serviceLauncher;
    private readonly WebView2 _webView;
    private readonly Panel _globalBlocker;
    private readonly Label _blockerTitle;
    private readonly Label _blockerDetail;
    private readonly System.Windows.Forms.Timer _healthTimer;
    private bool _started;
    private bool _closing;
    private bool _healthCheckInFlight;
    private bool _hasConnected;
    private bool _navigating;

    public PanelShellForm(PanelRuntimeOptions options)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _serviceLauncher = new PanelServiceLauncher(options);
        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            Visible = false,
        };
        _globalBlocker = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(32, 30, 26),
            Padding = new Padding(48),
        };
        _blockerTitle = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ForeColor = Color.FromArgb(237, 234, 227),
            Font = new Font("Segoe UI", 18F, FontStyle.Bold),
            Text = "面板服务不可用",
        };
        _blockerDetail = new Label
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ForeColor = Color.FromArgb(184, 176, 164),
            Font = new Font("Segoe UI", 10F),
            MaximumSize = new Size(900, 0),
            Padding = new Padding(0, 16, 0, 0),
            Text = "正在等待 loopback 服务恢复。",
        };
        _globalBlocker.Controls.Add(_blockerDetail);
        _globalBlocker.Controls.Add(_blockerTitle);

        _healthTimer = new System.Windows.Forms.Timer { Interval = 1_500 };
        _healthTimer.Tick += OnHealthTimerTick;
        _serviceLauncher.ServiceExited += OnServiceExited;

        Controls.Add(_webView);
        Controls.Add(_globalBlocker);
        Text = "Agent Panel";
        MinimumSize = new Size(1_024, 720);
        StartPosition = FormStartPosition.CenterScreen;
        Width = 1_440;
        Height = 920;
    }

    protected override async void OnShown(EventArgs eventArgs)
    {
        base.OnShown(eventArgs);
        if (_started)
        {
            return;
        }

        _started = true;
        try
        {
            await StartServiceAndNavigateAsync().ConfigureAwait(true);
            _healthTimer.Start();
        }
        catch (Exception exception)
        {
            ShowGlobalBlocker(exception);
            _healthTimer.Start();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs eventArgs)
    {
        _closing = true;
        _healthTimer.Stop();
        _serviceLauncher.ServiceExited -= OnServiceExited;
        try
        {
            _serviceLauncher.StopAsync().GetAwaiter().GetResult();
        }
        catch
        {
            // Closing the shell must not be held hostage by an already-dead service.
        }

        base.OnFormClosing(eventArgs);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _healthTimer.Dispose();
            _serviceLauncher.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }

        base.Dispose(disposing);
    }

    private void ConfigureWebView()
    {
        _webView.CoreWebView2.AddWebResourceRequestedFilter(
            "*",
            CoreWebView2WebResourceContext.All);
        _webView.CoreWebView2.NavigationStarting += OnNavigationStarting;
        _webView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            _navigating = false;
            if (args.IsSuccess) _hasConnected = true;
        };
        _webView.CoreWebView2.WebResourceRequested += OnWebResourceRequested;
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
    }

    private void OnNavigationStarting(
        object? sender,
        Microsoft.Web.WebView2.Core.CoreWebView2NavigationStartingEventArgs eventArgs)
    {
        if (!Uri.TryCreate(eventArgs.Uri, UriKind.Absolute, out var candidate)
            || !WebView2NetworkPolicy.IsAllowedNavigation(candidate, _options.ResolvedLoopbackUrl))
        {
            eventArgs.Cancel = true;
        }
    }

    private void OnWebResourceRequested(
        object? sender,
        CoreWebView2WebResourceRequestedEventArgs eventArgs)
    {
        if (Uri.TryCreate(eventArgs.Request.Uri, UriKind.Absolute, out var candidate)
            && WebView2NetworkPolicy.IsAllowedResource(candidate, _options.ResolvedLoopbackUrl))
        {
            return;
        }

        var coreWebView = _webView.CoreWebView2
            ?? throw new InvalidOperationException("WebView2 尚未初始化。");
        var body = new MemoryStream(Encoding.UTF8.GetBytes("blocked by agent-panel loopback policy"));
        eventArgs.Response = coreWebView.Environment.CreateWebResourceResponse(
            body,
            403,
            "Blocked by loopback policy",
            "Content-Type: text/plain; charset=utf-8");
    }

    private async void OnHealthTimerTick(object? sender, EventArgs eventArgs)
    {
        if (_closing || _healthCheckInFlight)
        {
            return;
        }

        _healthCheckInFlight = true;
        try
        {
            // 附着模式没有 owned process：只看 IsOwnedServiceRunning 会让每次 tick 都
            // 重走 StartAsync+Navigate，附着页面被 1.5s 一次反复重载（sol 体检后续排查）
            if (!_serviceLauncher.IsOwnedServiceRunning && !_serviceLauncher.IsAttached)
            {
                await StartServiceAndNavigateAsync().ConfigureAwait(true);
            }
            else if (await _serviceLauncher.IsHealthyAsync().ConfigureAwait(true))
            {
                ShowConnected();
            }
            else
            {
                ShowGlobalBlocker(null);
            }
        }
        catch (Exception exception)
        {
            ShowGlobalBlocker(exception);
        }
        finally
        {
            _healthCheckInFlight = false;
        }
    }

    private async Task StartServiceAndNavigateAsync()
    {
        await _serviceLauncher.StartAsync().ConfigureAwait(true);
        if (_webView.CoreWebView2 is null)
        {
            var environment = await CreateWebViewEnvironmentAsync().ConfigureAwait(true);
            await _webView.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
            ConfigureWebView();
        }

        ShowConnected();
    }

    private Task<CoreWebView2Environment> CreateWebViewEnvironmentAsync()
    {
        // WebView2 缓存落在用户级面板状态目录，不随监控仓切换、不写进任何项目目录。
        var userDataFolder = Path.Combine(_options.PanelStateRoot, "webview2");
        var environmentOptions = new CoreWebView2EnvironmentOptions(
            WebView2NetworkPolicy.AdditionalBrowserArguments);
        return CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder,
            environmentOptions);
    }

    private void OnServiceExited(object? sender, EventArgs eventArgs)
    {
        if (_closing || IsDisposed)
        {
            return;
        }

        try
        {
            BeginInvoke(new Action(() => ShowGlobalBlocker(null)));
        }
        catch (InvalidOperationException)
        {
            // The form is closing.
        }
    }

    private void ShowConnected()
    {
        _globalBlocker.Visible = false;
        _webView.Visible = true;
        // 已加载文档自行同步数据和连接身份。服务波动、重启都不重载用户草稿。
        if (!_hasConnected && !_navigating && _webView.CoreWebView2 is not null)
        {
            _navigating = true;
            _webView.CoreWebView2.Navigate(_options.ResolvedLoopbackUrl.AbsoluteUri);
        }
    }

    private void ShowGlobalBlocker(Exception? exception)
    {
        // 壳负责启动和进程恢复；首屏加载后，连接提示由网页单独负责。
        if (_hasConnected) return;
        _webView.Visible = false;
        _globalBlocker.Visible = true;
        var probe = _serviceLauncher.LastHealthProbe;
        var probeDetail = probe is null ? string.Empty : $"（{probe}）";
        _blockerDetail.Text = exception is null
            ? $"无法访问 {_options.ResolvedLoopbackUrl.AbsoluteUri}{probeDetail}。控制仓任务不会因面板退出而停止；服务恢复后将自动重试。"
            : $"无法启动或连接 {_options.ResolvedLoopbackUrl.AbsoluteUri}。{exception.Message}{probeDetail}";
    }
}
