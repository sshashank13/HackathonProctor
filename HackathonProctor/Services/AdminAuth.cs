using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using HackathonProctor.Models;

namespace HackathonProctor.Services;

/// <summary>Very small token-based admin login (password comes from appsettings.json).</summary>
public class AdminAuth
{
    private readonly byte[] _password;
    private readonly ConcurrentDictionary<string, DateTime> _tokens = new();

    public AdminAuth(AdminSettings settings)
    {
        _password = Encoding.UTF8.GetBytes(settings.Password ?? "");
    }

    public string? Login(string? password)
    {
        var attempt = Encoding.UTF8.GetBytes(password ?? "");
        if (!CryptographicOperations.FixedTimeEquals(attempt, _password))
            return null;

        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _tokens[token] = DateTime.UtcNow.AddHours(8);
        return token;
    }

    public bool IsValid(string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        if (!_tokens.TryGetValue(token, out var expires)) return false;
        if (expires > DateTime.UtcNow) return true;
        _tokens.TryRemove(token, out _);
        return false;
    }
}
