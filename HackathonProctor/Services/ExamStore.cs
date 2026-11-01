using System.Text;
using System.Text.Json;
using HackathonProctor.Models;

namespace HackathonProctor.Services;

/// <summary>
/// Thread-safe store for exam sessions. Everything is kept in memory and persisted to
/// App_Data/sessions.json after each change. Webcam snapshots are stored under App_Data/snapshots.
/// The server is the single source of truth for the timer, score and violation count.
/// </summary>
public class ExamStore
{
    private readonly object _gate = new();
    private readonly ExamSettings _settings;
    private readonly string _dataFile;
    private readonly string _snapshotRoot;
    private readonly List<Question> _bank = new();
    private List<ExamSession> _sessions = new();

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    public static readonly string[] Tracks = { "National", "International" };
    private static readonly string[] Decisions = { "Pending", "Shortlisted", "Waitlisted", "Rejected" };

    // Violation catalogue: weight (integrity points lost), whether it counts as a "strike", message shown to candidate.
    private static readonly Dictionary<string, (int Weight, bool Strike, string Message)> Catalogue =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["TabSwitch"] = (10, true, "You left the exam tab. Please stay on this page."),
            ["WindowBlur"] = (4, false, "The exam window lost focus."),
            ["FullscreenExit"] = (10, true, "You exited fullscreen mode. Return to fullscreen to continue."),
            ["CopyPaste"] = (5, true, "Copy / cut / paste is not allowed during the exam."),
            ["RightClick"] = (2, false, "Right-click is disabled during the exam."),
            ["BlockedShortcut"] = (4, false, "That keyboard shortcut is not allowed."),
            ["ScreenshotKey"] = (5, true, "Screenshots are not allowed during the exam."),
            ["NoFace"] = (8, true, "We cannot see your face. Please stay in front of the camera."),
            ["MultipleFaces"] = (15, true, "More than one person was detected in the camera."),
            ["CameraBlocked"] = (15, true, "Your camera appears to be covered or very dark."),
            ["CameraLost"] = (15, true, "Your camera stopped working."),
            ["MultipleDisplays"] = (10, true, "Multiple displays detected. Please use a single screen."),
        };

    public ExamStore(IWebHostEnvironment env, ExamSettings settings)
    {
        _settings = settings;

        var dataDir = Path.Combine(env.ContentRootPath, "App_Data");
        Directory.CreateDirectory(dataDir);
        _snapshotRoot = Path.Combine(dataDir, "snapshots");
        Directory.CreateDirectory(_snapshotRoot);
        _dataFile = Path.Combine(dataDir, "sessions.json");

        var questionFile = Path.Combine(env.ContentRootPath, "Data", "questions.json");
        if (File.Exists(questionFile))
        {
            var loaded = JsonSerializer.Deserialize<List<Question>>(File.ReadAllText(questionFile), JsonOpts);
            if (loaded != null) _bank = loaded;
        }

        if (File.Exists(_dataFile))
        {
            try
            {
                _sessions = JsonSerializer.Deserialize<List<ExamSession>>(File.ReadAllText(_dataFile), JsonOpts)
                            ?? new List<ExamSession>();
            }
            catch
            {
                _sessions = new List<ExamSession>();
            }
        }
    }

    public int BankSize => _bank.Count;

    // ------------------------------------------------------------------ helpers

    private void Save()
    {
        var tmp = _dataFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_sessions, JsonOpts));
        File.Move(tmp, _dataFile, true);
    }

    private ExamSession? Find(string id) => _sessions.FirstOrDefault(s => s.Id == id);

    private static string Trunc(string? value, int max)
    {
        var v = (value ?? "").Trim();
        return v.Length <= max ? v : v.Substring(0, max);
    }

    private static bool ValidEmail(string email)
    {
        try
        {
            var addr = new System.Net.Mail.MailAddress(email);
            return addr.Address == email;
        }
        catch
        {
            return false;
        }
    }

    private static (int Weight, bool Strike, string Message) Lookup(string type) =>
        Catalogue.TryGetValue(type, out var c) ? c : (3, false, "Unusual activity was logged.");

    /// <summary>Ends the exam automatically when the server clock passes the deadline.</summary>
    private void Refresh(ExamSession s)
    {
        if (s.Status == "InProgress" && s.EndsAt.HasValue && DateTime.UtcNow >= s.EndsAt.Value)
        {
            Finalize(s, "AutoSubmitted", "Time limit reached");
            Save();
        }
    }

    private void Finalize(ExamSession s, string status, string reason)
    {
        var score = 0;
        foreach (var qid in s.QuestionIds)
        {
            var q = _bank.FirstOrDefault(x => x.Id == qid);
            if (q != null && s.Answers.TryGetValue(qid, out var chosen) && chosen == q.CorrectIndex)
                score += q.Points;
        }

        var now = DateTime.UtcNow;
        s.Score = score;
        s.Status = status;
        s.SubmitReason = reason;
        s.SubmittedAt = s.EndsAt.HasValue && now > s.EndsAt.Value ? s.EndsAt.Value : now;
    }

    private int AddViolationInternal(ExamSession s, string type, string? detail, DateTime when)
    {
        var info = Lookup(type);
        s.Violations.Add(new Violation
        {
            Type = type,
            Detail = Trunc(detail, 200),
            Timestamp = when,
            Weight = info.Weight,
            IsStrike = info.Strike
        });
        return Scoring.Strikes(s);
    }

    private static AdminRow ToRow(ExamSession s) => new(
        s.Id, s.Name, s.Email, s.College, s.Track, s.Status,
        Scoring.Percentage(s), s.Score, s.TotalPoints, Scoring.Integrity(s),
        s.Violations.Count, Scoring.Strikes(s), Scoring.TimeTaken(s),
        s.Decision, s.DecisionOverride, s.IsDemo, s.CreatedAt, s.SubmitReason, s.Snapshots.Count);

    // ------------------------------------------------------------------ candidate side

    public (string? SessionId, string? Error) Register(RegisterRequest r)
    {
        var name = Trunc(r.Name, 80);
        var email = Trunc(r.Email, 120).ToLowerInvariant();
        var college = Trunc(r.College, 120);
        var track = Tracks.FirstOrDefault(t => t.Equals((r.Track ?? "").Trim(), StringComparison.OrdinalIgnoreCase));

        if (name.Length < 2) return (null, "Please enter your full name.");
        if (!ValidEmail(email)) return (null, "Please enter a valid email address.");
        if (college.Length < 2) return (null, "Please enter your college or organisation.");
        if (track == null) return (null, "Please choose the National or International track.");

        lock (_gate)
        {
            var existing = _sessions
                .Where(s => !s.IsDemo && s.Email == email)
                .OrderByDescending(s => s.CreatedAt)
                .FirstOrDefault();

            if (existing != null)
            {
                Refresh(existing);
                if (existing.Status == "Registered" || existing.Status == "InProgress")
                    return (existing.Id, null); // resume the same attempt
                if (!_settings.AllowRetake)
                    return (null, "This email address has already completed the exam.");
            }

            var session = new ExamSession { Name = name, Email = email, College = college, Track = track };
            _sessions.Add(session);
            Save();
            return (session.Id, null);
        }
    }

    public (bool Ok, string? Error) Begin(string id)
    {
        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return (false, "Session not found.");
            Refresh(s);

            if (s.Status == "Registered")
            {
                if (_bank.Count == 0) return (false, "The question bank is empty. Add questions to Data/questions.json.");

                IEnumerable<Question> pool = _bank;
                if (_settings.ShuffleQuestions)
                    pool = pool.OrderBy(_ => Random.Shared.Next());

                var chosen = pool.Take(Math.Min(_settings.QuestionsPerExam, _bank.Count)).ToList();
                s.QuestionIds = chosen.Select(q => q.Id).ToList();
                s.TotalPoints = chosen.Sum(q => q.Points);
                s.StartedAt = DateTime.UtcNow;
                s.EndsAt = s.StartedAt.Value.AddMinutes(_settings.DurationMinutes);
                s.Status = "InProgress";
                Save();
            }

            if (s.Status != "InProgress") return (false, "This exam has already ended.");
            return (true, null);
        }
    }

    public object? GetState(string id)
    {
        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return null;
            Refresh(s);

            var inProgress = s.Status == "InProgress";
            var finished = Scoring.IsFinished(s);

            // Correct answers are NEVER sent to the browser.
            var questions = new List<object>();
            if (inProgress)
            {
                foreach (var qid in s.QuestionIds)
                {
                    var q = _bank.FirstOrDefault(x => x.Id == qid);
                    if (q != null)
                        questions.Add(new { id = q.Id, category = q.Category, text = q.Text, options = q.Options, points = q.Points });
                }
            }

            var remaining = inProgress && s.EndsAt.HasValue
                ? Math.Max(0, (int)(s.EndsAt.Value - DateTime.UtcNow).TotalSeconds)
                : 0;

            return new
            {
                id = s.Id,
                name = s.Name,
                track = s.Track,
                status = s.Status,
                submitReason = s.SubmitReason,
                title = _settings.Title,
                remainingSeconds = remaining,
                durationSeconds = _settings.DurationMinutes * 60,
                strikes = Scoring.Strikes(s),
                maxStrikes = _settings.MaxViolations,
                snapshotIntervalSeconds = _settings.SnapshotIntervalSeconds,
                questions,
                answers = s.Answers,
                score = finished && _settings.ShowScoreToCandidate ? s.Score : (int?)null,
                total = finished && _settings.ShowScoreToCandidate ? s.TotalPoints : (int?)null
            };
        }
    }

    public bool SaveAnswer(string id, string? questionId, int optionIndex)
    {
        if (string.IsNullOrEmpty(questionId)) return false;

        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return false;
            Refresh(s);
            if (s.Status != "InProgress") return false;
            if (!s.QuestionIds.Contains(questionId)) return false;

            var q = _bank.FirstOrDefault(x => x.Id == questionId);
            if (q == null) return false;

            if (optionIndex < 0) s.Answers.Remove(questionId);
            else if (optionIndex < q.Options.Count) s.Answers[questionId] = optionIndex;
            else return false;

            Save();
            return true;
        }
    }

    public ViolationResult? AddViolation(string id, string? type, string? detail)
    {
        var t = new string((type ?? "").Where(char.IsLetterOrDigit).ToArray());
        t = Trunc(t, 40);
        if (t.Length == 0) t = "Unknown";

        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return null;
            Refresh(s);

            if (s.Status != "InProgress")
                return new ViolationResult(Scoring.Strikes(s), _settings.MaxViolations, true, "The exam has already ended.");

            var strikes = AddViolationInternal(s, t, detail, DateTime.UtcNow);
            var auto = strikes >= _settings.MaxViolations;
            if (auto)
                Finalize(s, "AutoSubmitted", "Ended automatically after reaching the maximum number of warnings");
            Save();

            return new ViolationResult(
                strikes,
                _settings.MaxViolations,
                auto,
                auto ? "Maximum warnings reached - your exam has been submitted." : Lookup(t).Message);
        }
    }

    public bool AddSnapshot(string id, string? dataUrl)
    {
        const string prefix = "data:image/jpeg;base64,";
        if (string.IsNullOrEmpty(dataUrl) || !dataUrl.StartsWith(prefix, StringComparison.Ordinal)) return false;
        if (dataUrl.Length > 600_000) return false;

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(dataUrl.Substring(prefix.Length));
        }
        catch (FormatException)
        {
            return false;
        }

        lock (_gate)
        {
            var s = Find(id);
            if (s == null || s.Status != "InProgress") return false;
            if (s.Snapshots.Count >= 300) return false;

            var dir = Path.Combine(_snapshotRoot, s.Id);
            Directory.CreateDirectory(dir);
            var file = $"{DateTime.UtcNow:yyyyMMdd_HHmmss_fff}.jpg";
            File.WriteAllBytes(Path.Combine(dir, file), bytes);
            s.Snapshots.Add(file);
            Save();
            return true;
        }
    }

    public object? Submit(string id, Dictionary<string, int>? answers, string? reason)
    {
        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return null;
            Refresh(s);

            if (s.Status == "InProgress")
            {
                // Merge any answers the browser could not save earlier (e.g. brief network drop).
                if (answers != null)
                {
                    foreach (var kv in answers)
                    {
                        var q = _bank.FirstOrDefault(x => x.Id == kv.Key);
                        if (q != null && s.QuestionIds.Contains(kv.Key) && kv.Value >= 0 && kv.Value < q.Options.Count)
                            s.Answers[kv.Key] = kv.Value;
                    }
                }

                var why = string.IsNullOrWhiteSpace(reason) ? "Submitted by candidate" : Trunc(reason, 120);
                Finalize(s, "Submitted", why);
                Save();
            }

            return new
            {
                status = s.Status,
                reason = s.SubmitReason,
                score = _settings.ShowScoreToCandidate && Scoring.IsFinished(s) ? s.Score : (int?)null,
                total = _settings.ShowScoreToCandidate && Scoring.IsFinished(s) ? s.TotalPoints : (int?)null
            };
        }
    }

    // ------------------------------------------------------------------ admin side

    public List<AdminRow> ListRows()
    {
        lock (_gate)
        {
            foreach (var s in _sessions.ToList()) Refresh(s);
            return _sessions.OrderByDescending(s => s.CreatedAt).Select(ToRow).ToList();
        }
    }

    public object? GetDetail(string id)
    {
        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return null;
            Refresh(s);

            var categories = s.QuestionIds
                .Select(qid => _bank.FirstOrDefault(q => q.Id == qid))
                .Where(q => q != null)
                .Select(q => q!)
                .GroupBy(q => q.Category)
                .Select(g => new
                {
                    category = g.Key,
                    total = g.Count(),
                    correct = g.Count(q => s.Answers.TryGetValue(q.Id, out var a) && a == q.CorrectIndex)
                })
                .ToList();

            return new
            {
                row = ToRow(s),
                violations = s.Violations.OrderBy(v => v.Timestamp).ToList(),
                snapshots = s.Snapshots,
                categories,
                remark = s.Remark,
                startedAt = s.StartedAt,
                submittedAt = s.SubmittedAt,
                answered = s.Answers.Count,
                totalQuestions = s.QuestionIds.Count
            };
        }
    }

    public string? GetSnapshotPath(string id, string file)
    {
        lock (_gate)
        {
            var s = Find(id);
            if (s == null || !s.Snapshots.Contains(file)) return null;
            return Path.Combine(_snapshotRoot, s.Id, file);
        }
    }

    public bool SetDecision(string id, string? decision, string? remark)
    {
        var d = Decisions.FirstOrDefault(x => x.Equals((decision ?? "").Trim(), StringComparison.OrdinalIgnoreCase));
        if (d == null) return false;

        lock (_gate)
        {
            var s = Find(id);
            if (s == null) return false;
            s.Decision = d;
            s.DecisionOverride = d != "Pending";
            if (remark != null) s.Remark = Trunc(remark, 500);
            Save();
            return true;
        }
    }

    /// <summary>
    /// Ranks finished candidates per track. A candidate is eligible when percentage >= cutoff and integrity >= minimum.
    /// Eligible candidates are ordered by score, then integrity, then speed. Top N become Shortlisted, the rest Waitlisted;
    /// non-eligible become Rejected. Manual decisions made by organisers are never overwritten.
    /// </summary>
    public object AutoShortlist(ShortlistRequest r)
    {
        lock (_gate)
        {
            int shortlisted = 0, waitlisted = 0, rejected = 0;

            foreach (var track in Tracks)
            {
                var seats = Math.Max(0, track == "National" ? r.NationalSeats : r.InternationalSeats);

                var pool = _sessions
                    .Where(s => s.Track == track && Scoring.IsFinished(s) && !s.DecisionOverride)
                    .ToList();

                var manualShortlisted = _sessions.Count(s => s.Track == track && s.DecisionOverride && s.Decision == "Shortlisted");
                var seatsLeft = Math.Max(0, seats - manualShortlisted);

                var eligible = pool
                    .Where(s => Scoring.Percentage(s) >= r.CutoffPercent && Scoring.Integrity(s) >= r.MinIntegrity)
                    .OrderByDescending(s => Scoring.Percentage(s))
                    .ThenByDescending(s => Scoring.Integrity(s))
                    .ThenBy(s => Scoring.TimeTaken(s))
                    .ToList();

                for (var i = 0; i < eligible.Count; i++)
                {
                    if (i < seatsLeft) { eligible[i].Decision = "Shortlisted"; shortlisted++; }
                    else { eligible[i].Decision = "Waitlisted"; waitlisted++; }
                }

                foreach (var s in pool.Where(p => !eligible.Contains(p)))
                {
                    s.Decision = "Rejected";
                    rejected++;
                }
            }

            Save();
            return new { shortlisted, waitlisted, rejected };
        }
    }

    public string ExportCsv()
    {
        lock (_gate)
        {
            var sb = new StringBuilder();
            sb.AppendLine("Rank,Name,Email,College,Track,Status,Score,Total,Percentage,Integrity,Violations,TimeTakenMin,Decision,Remark");

            var finished = _sessions.Where(s => Scoring.IsFinished(s)).ToList();
            foreach (var group in finished.GroupBy(s => s.Track).OrderBy(g => g.Key))
            {
                var rank = 1;
                foreach (var s in group
                             .OrderByDescending(x => Scoring.Percentage(x))
                             .ThenByDescending(x => Scoring.Integrity(x))
                             .ThenBy(x => Scoring.TimeTaken(x)))
                {
                    sb.AppendLine(string.Join(",", new[]
                    {
                        rank.ToString(),
                        Csv(s.Name), Csv(s.Email), Csv(s.College), Csv(s.Track), Csv(s.Status),
                        s.Score.ToString(), s.TotalPoints.ToString(),
                        Scoring.Percentage(s).ToString("0.0"),
                        Scoring.Integrity(s).ToString(),
                        s.Violations.Count.ToString(),
                        (Scoring.TimeTaken(s) / 60.0).ToString("0.0"),
                        Csv(s.Decision), Csv(s.Remark)
                    }));
                    rank++;
                }
            }

            return sb.ToString();
        }
    }

    private static string Csv(string? value)
    {
        var v = value ?? "";
        // Guard against spreadsheet formula injection.
        if (v.Length > 0 && (v[0] == '=' || v[0] == '+' || v[0] == '-' || v[0] == '@')) v = "'" + v;
        if (v.Contains('"') || v.Contains(',') || v.Contains('\n') || v.Contains('\r'))
            v = "\"" + v.Replace("\"", "\"\"") + "\"";
        return v;
    }

    // ------------------------------------------------------------------ demo data

    public int SeedDemo()
    {
        lock (_gate)
        {
            string[] names =
            {
                "Aarav Sharma", "Diya Patel", "Liam Carter", "Ananya Iyer", "Sofia Rossi", "Rohan Mehta",
                "Noah Kim", "Ishita Gupta", "Emma Dubois", "Arjun Verma", "Mei Tanaka", "Kabir Singh",
                "Olivia Brown", "Meera Nair", "Lucas Silva", "Saanvi Joshi"
            };
            string[] colleges =
            {
                "IIT Delhi", "NIT Trichy", "BITS Pilani", "IIIT Hyderabad", "VIT Vellore",
                "National University of Singapore", "TU Munich", "University of Toronto", "Thapar Institute"
            };
            string[] types = { "TabSwitch", "WindowBlur", "FullscreenExit", "CopyPaste", "RightClick", "NoFace", "BlockedShortcut" };

            var rnd = Random.Shared;
            var created = 0;

            for (var i = 0; i < names.Length; i++)
            {
                var s = new ExamSession
                {
                    Name = names[i],
                    Email = $"demo{i + 1}@demo.local",
                    College = colleges[rnd.Next(colleges.Length)],
                    Track = Tracks[i % 2],
                    IsDemo = true
                };

                var pool = _bank.OrderBy(_ => rnd.Next()).Take(Math.Min(_settings.QuestionsPerExam, _bank.Count)).ToList();
                s.QuestionIds = pool.Select(q => q.Id).ToList();
                s.TotalPoints = pool.Sum(q => q.Points);

                var skill = 0.35 + rnd.NextDouble() * 0.6;
                foreach (var q in pool)
                {
                    var roll = rnd.NextDouble();
                    if (roll < skill)
                        s.Answers[q.Id] = q.CorrectIndex;
                    else if (roll < skill + (1 - skill) * 0.7 && q.Options.Count > 1)
                        s.Answers[q.Id] = (q.CorrectIndex + 1 + rnd.Next(q.Options.Count - 1)) % q.Options.Count;
                }

                s.StartedAt = DateTime.UtcNow.AddMinutes(-(40 + rnd.Next(300)));
                s.EndsAt = s.StartedAt.Value.AddMinutes(_settings.DurationMinutes);

                var count = rnd.NextDouble() < 0.5 ? 0 : rnd.Next(1, 5);
                for (var v = 0; v < count; v++)
                    AddViolationInternal(s, types[rnd.Next(types.Length)], "Demo event", s.StartedAt.Value.AddMinutes(rnd.Next(2, 20)));

                Finalize(s, "Submitted", "Submitted by candidate");
                s.SubmittedAt = s.StartedAt.Value.AddMinutes(Math.Max(1, _settings.DurationMinutes - rnd.Next(2, 12)));

                _sessions.Add(s);
                created++;
            }

            Save();
            return created;
        }
    }

    public int ClearDemo()
    {
        lock (_gate)
        {
            var removed = _sessions.RemoveAll(s => s.IsDemo);
            Save();
            return removed;
        }
    }
}
