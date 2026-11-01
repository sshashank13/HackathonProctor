using System.Text;
using HackathonProctor.Models;
using HackathonProctor.Services;

var builder = WebApplication.CreateBuilder(args);

var examSettings = builder.Configuration.GetSection("Exam").Get<ExamSettings>() ?? new ExamSettings();
var adminSettings = builder.Configuration.GetSection("Admin").Get<AdminSettings>() ?? new AdminSettings();
var shortlistDefaults = builder.Configuration.GetSection("Shortlist").Get<ShortlistDefaults>() ?? new ShortlistDefaults();

builder.Services.AddSingleton(examSettings);
builder.Services.AddSingleton(adminSettings);
builder.Services.AddSingleton(shortlistDefaults);
builder.Services.AddSingleton<ExamStore>();
builder.Services.AddSingleton<AdminAuth>();

var app = builder.Build();

// ---------------------------------------------------------------- middleware

app.Use(async (ctx, next) =>
{
    ctx.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    ctx.Response.Headers["Permissions-Policy"] = "camera=(self), fullscreen=(self)";
    if (ctx.Request.Path.StartsWithSegments("/api"))
        ctx.Response.Headers["Cache-Control"] = "no-store";
    await next();
});

// Everything under /api/admin needs a valid organiser token (header, or ?t= for <img> tags).
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/api/admin"))
    {
        var auth = ctx.RequestServices.GetRequiredService<AdminAuth>();
        var token = ctx.Request.Headers["X-Admin-Token"].FirstOrDefault() ?? ctx.Request.Query["t"].FirstOrDefault();
        if (!auth.IsValid(token))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await ctx.Response.WriteAsJsonAsync(new { error = "Unauthorized" });
            return;
        }
    }
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

// ---------------------------------------------------------------- candidate API

app.MapGet("/api/config", (ExamStore store) => Results.Ok(new
{
    title = examSettings.Title,
    durationMinutes = examSettings.DurationMinutes,
    questions = Math.Min(examSettings.QuestionsPerExam, store.BankSize),
    maxViolations = examSettings.MaxViolations
}));

app.MapPost("/api/exam/register", (RegisterRequest req, ExamStore store) =>
{
    var (id, error) = store.Register(req);
    return error != null
        ? Results.BadRequest(new { error })
        : Results.Ok(new { sessionId = id });
});

app.MapGet("/api/exam/{id}", (string id, ExamStore store) =>
{
    var state = store.GetState(id);
    return state == null ? Results.NotFound(new { error = "Session not found." }) : Results.Ok(state);
});

app.MapPost("/api/exam/{id}/begin", (string id, ExamStore store) =>
{
    var (ok, error) = store.Begin(id);
    return ok ? Results.Ok(new { ok = true }) : Results.BadRequest(new { error });
});

app.MapPost("/api/exam/{id}/answer", (string id, AnswerRequest req, ExamStore store) =>
    store.SaveAnswer(id, req.QuestionId, req.OptionIndex)
        ? Results.Ok(new { saved = true })
        : Results.BadRequest(new { error = "Answer could not be saved (exam not active?)." }));

app.MapPost("/api/exam/{id}/violation", (string id, ViolationRequest req, ExamStore store) =>
{
    var result = store.AddViolation(id, req.Type, req.Detail);
    return result == null ? Results.NotFound(new { error = "Session not found." }) : Results.Ok(result);
});

app.MapPost("/api/exam/{id}/snapshot", (string id, SnapshotRequest req, ExamStore store) =>
    store.AddSnapshot(id, req.Image) ? Results.Ok(new { saved = true }) : Results.BadRequest(new { saved = false }));

app.MapPost("/api/exam/{id}/submit", (string id, SubmitRequest req, ExamStore store) =>
{
    var result = store.Submit(id, req.Answers, req.Reason);
    return result == null ? Results.NotFound(new { error = "Session not found." }) : Results.Ok(result);
});

// ---------------------------------------------------------------- organiser API

app.MapPost("/api/auth/admin", async (LoginRequest req, AdminAuth auth) =>
{
    var token = auth.Login(req.Password);
    if (token == null)
    {
        await Task.Delay(500); // slow down password guessing
        return Results.Json(new { error = "Incorrect password." }, statusCode: StatusCodes.Status401Unauthorized);
    }
    return Results.Ok(new { token });
});

app.MapGet("/api/admin/settings", () => Results.Ok(new
{
    cutoffPercent = shortlistDefaults.CutoffPercent,
    nationalSeats = shortlistDefaults.NationalSeats,
    internationalSeats = shortlistDefaults.InternationalSeats,
    minIntegrity = shortlistDefaults.MinIntegrity,
    maxViolations = examSettings.MaxViolations,
    demoTools = adminSettings.EnableDemoTools
}));

app.MapGet("/api/admin/candidates", (ExamStore store) => Results.Ok(store.ListRows()));

app.MapGet("/api/admin/candidates/{id}", (string id, ExamStore store) =>
{
    var detail = store.GetDetail(id);
    return detail == null ? Results.NotFound() : Results.Ok(detail);
});

app.MapGet("/api/admin/snapshot/{id}/{file}", (string id, string file, ExamStore store) =>
{
    var path = store.GetSnapshotPath(id, file);
    return path != null && File.Exists(path) ? Results.File(path, "image/jpeg") : Results.NotFound();
});

app.MapPost("/api/admin/candidates/{id}/decision", (string id, DecisionRequest req, ExamStore store) =>
    store.SetDecision(id, req.Decision, req.Remark)
        ? Results.Ok(new { ok = true })
        : Results.BadRequest(new { error = "Invalid decision or candidate." }));

app.MapPost("/api/admin/shortlist", (ShortlistRequest req, ExamStore store) => Results.Ok(store.AutoShortlist(req)));

app.MapGet("/api/admin/export", (ExamStore store) =>
{
    var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(store.ExportCsv())).ToArray();
    return Results.File(bytes, "text/csv", "hackathon-shortlist.csv");
});

app.MapPost("/api/admin/demo/seed", (ExamStore store) =>
    adminSettings.EnableDemoTools
        ? Results.Ok(new { created = store.SeedDemo() })
        : Results.BadRequest(new { error = "Demo tools are disabled in appsettings.json." }));

app.MapDelete("/api/admin/demo", (ExamStore store) =>
    adminSettings.EnableDemoTools
        ? Results.Ok(new { removed = store.ClearDemo() })
        : Results.BadRequest(new { error = "Demo tools are disabled in appsettings.json." }));

app.Run();
