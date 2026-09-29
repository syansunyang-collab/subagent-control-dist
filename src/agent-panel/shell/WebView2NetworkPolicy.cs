namespace AgentPanel.Shell;

public static class WebView2NetworkPolicy
{
    public const string AdditionalBrowserArguments =
        "--disable-background-networking "
        + "--disable-component-update "
        + "--disable-domain-reliability "
        + "--disable-sync "
        + "--disable-extensions "
        + "--no-first-run "
        + "--no-default-browser-check "
        + "--proxy-server=direct://";

    public static bool IsAllowedNavigation(Uri? candidate, Uri expected)
    {
        return candidate is not null && LoopbackEndpoint.IsLockedRoot(candidate, expected);
    }

    public static bool IsAllowedResource(Uri? candidate, Uri expected)
    {
        if (candidate is null)
        {
            return false;
        }

        if (candidate.Scheme.Equals("about", StringComparison.OrdinalIgnoreCase)
            || candidate.Scheme.Equals("data", StringComparison.OrdinalIgnoreCase)
            || candidate.Scheme.Equals("blob", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return candidate.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && candidate.Host.Equals(expected.Host, StringComparison.OrdinalIgnoreCase)
            && candidate.Port == expected.Port
            && candidate.UserInfo.Length == 0;
    }
}
