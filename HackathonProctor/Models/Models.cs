namespace HackathonProctor.Models;

// ---------- Configuration ----------

public class ExamSettings
{
    public string Title { get; set; } = "Hackathon Screening Test";
    public int DurationMinutes { get; set; } = 30;
    public int QuestionsPerExam { get; set; } = 20;
    public int MaxViolations { get; set; } = 5;
    public int SnapshotIntervalSeconds { get; set; } = 30;
    public bool ShuffleQuestions { get; set; } = true;
    public bool AllowRetake { get; set; } = false;
    public bool ShowScoreToCandidate { get; set; } = false;
}

public class AdminSettings
{
    public string Password { get; set; } = "admin@123";
    public bool EnableDemoTools { get; set; } = true;
}

public class ShortlistDefaults
{
    public double CutoffPercent { get; set; } = 60;
    public int NationalSeats { get; set; } = 10;
    public int InternationalSeats { get; set; } = 5;
    public double MinIntegrity { get; set; } = 60;
}

// ---------- Domain ----------

public class Question
{
    public string Id { get; set; } = "";
    public string Category { get; set; } = "";
    public string Text { get; set; } = "";
    public List<string> Options { get; set; } = new();
    public int CorrectIndex { get; set; }
    public int Points { get; set; } = 1;
}

public class Violation
{
    public string Type { get; set; } = "";
    public string Detail { get; set; } = "";
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public int Weight { get; set; }
    public bool IsStrike { get; set; }
}

public class ExamSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string College { get; set; } = "";
    public string Track { get; set; } = "National";

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndsAt { get; set; }
    public DateTime? SubmittedAt { get; set; }

    // Registered | InProgress | Submitted | AutoSubmitted
    public string Status { get; set; } = "Registered";
    public string? SubmitReason { get; set; }

    public List<string> QuestionIds { get; set; } = new();
    public Dictionary<string, int> Answers { get; set; } = new();
    public List<Violation> Violations { get; set; } = new();
    public List<string> Snapshots { get; set; } = new();

    public int Score { get; set; }
    public int TotalPoints { get; set; }

    // Pending | Shortlisted | Waitlisted | Rejected
    public string Decision { get; set; } = "Pending";
    public bool DecisionOverride { get; set; }
    public string? Remark { get; set; }
    public bool IsDemo { get; set; }
}

public static class Scoring
{
    public static double Percentage(ExamSession s) =>
        s.TotalPoints > 0 ? Math.Round(100.0 * s.Score / s.TotalPoints, 1) : 0;

    /// <summary>100 minus the weight of every logged violation (never below 0).</summary>
    public static int Integrity(ExamSession s) =>
        Math.Max(0, 100 - s.Violations.Sum(v => v.Weight));

    public static int Strikes(ExamSession s) => s.Violations.Count(v => v.IsStrike);

    public static int TimeTaken(ExamSession s) =>
        s.StartedAt.HasValue && s.SubmittedAt.HasValue
            ? Math.Max(0, (int)(s.SubmittedAt.Value - s.StartedAt.Value).TotalSeconds)
            : 0;

    public static bool IsFinished(ExamSession s) =>
        s.Status == "Submitted" || s.Status == "AutoSubmitted";
}

// ---------- Requests / responses ----------

public record RegisterRequest(string? Name, string? Email, string? College, string? Track);
public record AnswerRequest(string? QuestionId, int OptionIndex);
public record ViolationRequest(string? Type, string? Detail);
public record SnapshotRequest(string? Image);
public record SubmitRequest(Dictionary<string, int>? Answers, string? Reason);
public record LoginRequest(string? Password);
public record DecisionRequest(string? Decision, string? Remark);
public record ShortlistRequest(double CutoffPercent, int NationalSeats, int InternationalSeats, double MinIntegrity);

public record ViolationResult(int Strikes, int MaxStrikes, bool AutoSubmitted, string Message);

public record AdminRow(
    string Id,
    string Name,
    string Email,
    string College,
    string Track,
    string Status,
    double Percentage,
    int Score,
    int TotalPoints,
    int Integrity,
    int Violations,
    int Strikes,
    int TimeTakenSeconds,
    string Decision,
    bool DecisionOverride,
    bool IsDemo,
    DateTime CreatedAt,
    string? SubmitReason,
    int SnapshotCount);
