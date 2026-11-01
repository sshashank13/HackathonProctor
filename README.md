# HackProctor – Proctored Exam & Shortlisting Tool

An ASP.NET Core (C#) web app that screens candidates for **national** and **international** hackathons.
Candidates take a timed MCQ exam under webcam proctoring; organisers rank them and shortlist per track.

No database and no NuGet packages are needed – data is stored as JSON in `App_Data/`.

---

## How to run in Visual Studio

1. Install **Visual Studio 2022 (17.8+) or Visual Studio 2026** with the **“ASP.NET and web development”** workload (this includes the .NET SDK).
2. Unzip the folder and double-click **`HackathonProctor.sln`**.
3. If Visual Studio says the target framework is missing, open `HackathonProctor/HackathonProctor.csproj` and change  
   `<TargetFramework>net8.0</TargetFramework>` to the SDK you have (`net9.0` or `net10.0`).
4. Make sure the startup project is **HackathonProctor** and the profile (next to the green ▶ button) is **http**.
5. Press **F5** (or Ctrl+F5). The browser opens at **http://localhost:5080**.

### Using the command line instead
```
cd HackathonProctor
dotnet run --launch-profile http
```
then open http://localhost:5080.

---

## Try it in 2 minutes

1. Open **http://localhost:5080/admin.html** → password **`admin@123`** → click **“＋ Load demo candidates”** to see the dashboard with sample data.
2. Open **http://localhost:5080**, register, allow the camera, tick the agreement and click **Enter fullscreen & begin**.
3. Try switching tabs, pressing Esc, or right-clicking to see warnings. After 5 warnings the exam is submitted automatically.
4. Back in the console, press **Run auto-shortlisting**, open a candidate to review the proctoring log and webcam snapshots, then **Export CSV**.

---

## Features

**Candidate side**
- Registration with National / International track
- System check (camera, fullscreen, multiple-display detection) and consent
- Server-controlled timer (refresh or reopen the tab – the clock keeps running)
- Auto-save of every answer, question palette, mark-for-review, keyboard shortcuts (A–D, arrows)
- Correct answers never leave the server

**Proctoring**
- Tab switch / window focus loss, fullscreen exit, copy / cut / paste, right-click, DevTools & print/save shortcuts, Print Screen
- Webcam snapshots every 30 s (and instantly on face-related events)
- Camera covered / dark frame, camera disconnected, extended (multi-monitor) display
- Face detection: no face / multiple faces (see *Face detection* below)
- Each event has an integrity weight; “strikes” trigger auto-submit at the configured limit

**Organiser console**
- Live dashboard (auto-refresh), filters, search, per-track ranking
- Auto-shortlisting: cut-off score + minimum integrity + seats per track (Shortlisted / Waitlisted / Rejected)
- Candidate detail: score by category, violation timeline, snapshot gallery, remarks, manual override
- CSV export, demo-data tools

---

## Configuration – `HackathonProctor/appsettings.json`

| Setting | Meaning |
|---|---|
| `Exam:Title` | Name shown to candidates |
| `Exam:DurationMinutes` | Exam length |
| `Exam:QuestionsPerExam` | Random questions drawn from the bank |
| `Exam:MaxViolations` | Warnings (“strikes”) before auto-submit |
| `Exam:SnapshotIntervalSeconds` | Webcam snapshot frequency |
| `Exam:AllowRetake` | Allow the same email to attempt again |
| `Exam:ShowScoreToCandidate` | Show the score after submission |
| `Admin:Password` | **Change this** before real use |
| `Admin:EnableDemoTools` | Show demo-data buttons |
| `Shortlist:*` | Default values in the shortlisting form |

**Questions:** edit `HackathonProctor/Data/questions.json` (id, category, text, options, `correctIndex` starting from 0, points). 25 sample questions are included.

**Where data lives:** `HackathonProctor/App_Data/sessions.json` and `App_Data/snapshots/<session>/…jpg`. Delete the folder to reset everything.

---

## Shortlisting logic

1. Only finished attempts are considered, per track.
2. Eligible = score % ≥ cut-off **and** integrity ≥ minimum.
3. Eligible candidates are ordered by score → integrity → time taken.
4. Top *N* (seats) become **Shortlisted**, the rest of the eligible **Waitlisted**, everyone else **Rejected**.
5. Manual decisions (✓ / ✕ / detail dialog) are kept and count against the seats.

---

## Face detection – please read

Browsers do not expose face detection everywhere, so the tool tries, in order:
1. The browser’s native `FaceDetector` (Chrome/Edge with *Experimental Web Platform features* enabled in `chrome://flags`).
2. **face-api.js** loaded from the jsDelivr CDN (needs internet on the candidate’s machine).
3. If neither works, the exam still runs; camera-blocked detection and periodic snapshots remain, and organisers review snapshots manually.

The face chip on the exam page shows which mode is active (“Face detected” or “Snapshots only”).

---

## Before using this for real candidates

- Automated flags are **signals, not verdicts** – always review snapshots before rejecting someone.
- Serve over **HTTPS** (camera access works on `localhost` and HTTPS only) and **change the admin password**.
- Tell candidates what is recorded and how long you keep it; delete `App_Data` when the event ends (privacy / data-protection rules).
- Browser-based proctoring cannot stop a second device or a determined cheater; it deters and records. For high-stakes rounds add a live invigilator.
- Registering with an email resumes that attempt – add email OTP verification if impersonation is a concern.
- For large events replace the JSON storage in `Services/ExamStore.cs` with a database.

---

## Project layout

```
HackathonProctor.sln
HackathonProctor/
  Program.cs                 minimal API endpoints + admin token middleware
  Models/Models.cs           settings, domain classes, scoring helpers, DTOs
  Services/ExamStore.cs      sessions, timer, scoring, violations, shortlisting, CSV
  Services/AdminAuth.cs      organiser login tokens
  Data/questions.json        question bank
  appsettings.json           configuration
  Properties/launchSettings.json
  wwwroot/
    index.html  exam.html  admin.html
    css/site.css             soft pastel theme
    js/common.js  register.js  exam.js  admin.js
```
