using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace AgentPanel.Shell;

public static class LoopbackEndpoint
{
    public const string Host = "127.0.0.1";
    public const int MinimumPort = 43_000;
    public const int PortSpan = 1_000;

    public static Uri ForRepository(string repositoryPath)
    {
        return Create(DerivePort(repositoryPath));
    }

    public static int DerivePort(string repositoryPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryPath);

        var fullPath = Path.GetFullPath(repositoryPath);
        fullPath = Path.TrimEndingDirectorySeparator(fullPath);
        var normalizedPath = fullPath.Replace('\\', '/').ToLowerInvariant();
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(normalizedPath));
        var value = BinaryPrimitives.ReadUInt16BigEndian(digest.AsSpan(0, sizeof(ushort)));

        return MinimumPort + (value % PortSpan);
    }

    public static Uri Create(int port)
    {
        if (port is < 1 or > 65_535)
        {
            throw new ArgumentOutOfRangeException(nameof(port), port, "loopback 端口必须位于 1-65535 范围内。");
        }

        return new Uri($"http://{Host}:{port}/", UriKind.Absolute);
    }

    public static bool IsLockedRoot(Uri? candidate, Uri expected)
    {
        return candidate is not null
            && candidate.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && candidate.Host.Equals(Host, StringComparison.OrdinalIgnoreCase)
            && candidate.Port == expected.Port
            && candidate.AbsolutePath == "/"
            && candidate.Query.Length == 0
            && candidate.Fragment.Length == 0
            && candidate.UserInfo.Length == 0;
    }
}
