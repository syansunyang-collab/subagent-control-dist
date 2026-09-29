using System.Diagnostics;

namespace AgentPanel.Shell;

public sealed class PanelOwnedProcess : IAsyncDisposable
{
    private Process? _process;

    public PanelOwnedProcess(Process process)
    {
        _process = process ?? throw new ArgumentNullException(nameof(process));
    }

    public int ProcessId
    {
        get
        {
            var process = _process ?? throw new ObjectDisposedException(nameof(PanelOwnedProcess));
            return process.Id;
        }
    }

    public bool IsRunning
    {
        get
        {
            var process = _process;
            if (process is null)
            {
                return false;
            }

            try
            {
                return !process.HasExited;
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var process = Interlocked.Exchange(ref _process, null);
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidOperationException)
        {
            // The process exited between HasExited and Kill/WaitForExitAsync.
        }
        finally
        {
            process.Dispose();
        }
    }

    public ValueTask DisposeAsync()
    {
        return new ValueTask(StopAsync());
    }
}
