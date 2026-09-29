namespace AgentPanel.Shell;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new PanelShellForm(PanelRuntimeOptions.Parse(args)));
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                $"Agent Panel 启动失败：{exception.Message}",
                "Agent Panel",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Environment.ExitCode = 1;
        }
    }
}
