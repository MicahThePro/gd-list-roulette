# Feature Ideas for GD List Roulette

A long, practical list of additions that would fit this codebase. Each idea notes
where it plugs in (`src/utils/roulette.js`, `worker/`, `src/pages/`, etc.), why it
makes sense for a roulette challenge platform, and how much work it is.

Effort scale: **S** (a few hours) · **M** (a weekend) · **L** (a real feature).

---

## 1. Core run mechanics

1. **Per-round timer display + pace warning** — `useGameRules.js` already tracks
   level/total limits; surface a live "you have been on this level 4:12 of 6:00"
   readout with a color shift at 80%. *S.*
2. **Pause / resume a run** — a run currently dies on refresh. Store the active run
   in `localStorage` + the `player_data` mirror so closing the tab pauses instead of
   ending. Needs a `pausedAt` field so elapsed time is not counted while paused. *M.*
3. **Abandon run vs. fail run** — a distinct "abandon" status so players can drop a
   bad run without it counting as a failure in stats. *S.*
4. **Retry the same level once per run ("second chance")** — a limited pity system:
   one free retry per run, tracked on the run object, disallowed on 100% targets.
   *S, but it needs a leaderboard eligibility rule.*
5. **Speedrun mode** — countdown starts the moment the level appears; no pause
   between rounds. Combine with existing total time limit. *S.*
6. **Mirror mode (boss-like)** — if the player fails, the next level's target is
   halved. Escalating tension, purely client-side. *S.*
7. **Progressive step** — step grows every N rounds (1% → 2% → 3%…). `getNextTargetPercent`
   is the single place this changes. *S.*
8. **No-duplicate streak bonus** — reward long runs without repeats with a score
   multiplier, similar to the scoring GD itself uses. *M.*
9. **Hidden level preview** — before starting, reveal 3 of the possible levels and
   ban them from the draw. Skill expression for prepared players. *M.*
10. **Endurance mode** — no level/total time limit, but the run only ends at 100%
    or on failure; existing rules already allow this (0 = off), so this is mostly a
    preset button. *S.*

## 2. Lists and difficulty

11. **Difficulty rating filter** — Pointercrate parts, tier, and star rating are
    already parsed; let players filter a run to a rating band. *M.*
12. **Custom weighted lists** — `CustomRunBuilder.jsx` exists; add per-list weights so
    heavy/light levels appear more or less often. *M.*
13. **List version pinning** — record which list snapshot a run was played against so
    an old leaderboard entry can still be validated after `challenge-list.json`
    updates. Same rationale as the frozen `pointercrateParts` field. *M.*
14. **"Unfair/glitched" auto-report** — when a player picks the unfair skip reason,
    offer to attach the level ID to a public glitch report list. *M.*
15. **Cross-list marathons** — draw from two sources at once with a visible source
    badge per round. *M.*
16. **Length buckets** — filter to short/medium/long levels using length seconds.
    *S.*

## 3. Verification and leaderboard trust

17. **Verification strength tiers** — differentiate a run submitted with continuous
    video from one with a single clip; show a badge per tier. *M.*
18. **Attempt counter proof** — players state total attempts; a moderator can compare
    against round count to catch padded submissions. *S.*
19. **Automatic run-seed signing** — sign each run at start (HMAC of runId + rules) and
    verify on submit so the client cannot alter rules after the fact. Extends the
    existing `worker/auth.js` token model. *M.*
20. **Duplicate-submission detection** — flag near-identical submissions (same
    duration, same level order hash). *M.*
21. **Reviewer notes on rejection** — moderators can leave a reason; currently a
    rejection is a dead end for the player. *S.*
22. **Appeals flow** — a player can contest a decision once. *M.*
23. **Leaderboard tie-breaker display** — show what broke a tie (fewer attempts,
   shorter time) next to the rank. *S.*
24. **Seasonal leaderboards** — reset boards quarterly, keep an all-time board too.
    *M.*

## 4. Profiles and social

25. **Personal bests per list/step** — "your deepest run on AREDL at 1% step". Derived
    entirely from existing run data. *M.*
26. **Run history filters** — by list source, step, result, date. The profile already
    paginates; filtering on top is cheap. *S.*
27. **Favorites / bookmarks on runs** — let players save other people's runs as
    inspiration, or save level IDs. *M.*
28. **Compare two profiles** — head-to-head stats view. *S.*
29. **Follow feed** — activity from followed users, reusing `notifications`. *M.*
30. **Profile completion / onboarding checklist** — display name, bio, first run.
    *S.*
31. **Achievements** — first 100%, 10-run streak, no-skip clear, marathon clear.
    Badges stored server-side and shown on the profile next to admin badges. *M.*
32. **Profile bio + pronouns + favorite difficulty** — small text fields, big payoff
    for a community site. *S.*
33. **Blocked users** — hide another player's runs and leaderboard entries from your
    view without deleting them. Needs a `blocks` table. *M.*

## 5. Moderation and admin

34. **Bulk submission actions** — approve/reject several pending submissions at once.
    *S.*
35. **Moderator assignment** — assign a reviewer to a submission so two mods don't
    duplicate work. *M.*
36. **Submission filters** — filter queue by list, step, date, flagged player. *S.*
37. **Flag system** — any user can flag a run/profile; mods see a flag queue.
    *M.*
38. **Report history per user** — a mod-visible timeline of flags and actions. *M.*
39. **Slow-mode / rate limiting on account actions** — already have lockout for the
    passcode; extend to login attempts and run submission frequency. *M.*
40. **Admin search improvements** — search by run ID, level ID, video host. *S.*
41. **Data export tool** — dump a user's data as JSON from the admin panel for
    support requests. *S.*
42. **Ban with reason and expiry** — temporary bans instead of only deletion.
    *M.*
43. **Changelog-from-admin** — publish changelog entries from the admin panel instead
    of editing `src/data`. *M.*

## 6. UX and quality of life

44. **Keyboard shortcuts** — Enter to pass, S to skip, Space to pause. *S.*
45. **Sound design toggle** — pass/fail/level-draw sounds with a mute switch, persisted
    like the other cookies. *S.*
46. **Reduced-motion mode** — respects the OS setting and disables the spinner
    animations. *S.*
47. **Practice mode on any level** — no run, no leaderboard effect, for warming up.
    *S.*
48. **Level search before starting** — remove a level you know you cannot do. *S.*
49. **Copy run summary as text** — one click to paste your run into Discord. *S.*
50. **Offline/total-request error banner** — `WorkerSignal.jsx` should explain what is
    broken rather than silently degrading. *S.*
51. **Settings reset button** — clears the per-cookie preferences at once. *S.*
52. **Mobile layout pass** — the run screen is dense; a stacked mobile layout would
    make it playable on a phone during practice. *M.*
53. **Full results breakdown page** — a per-round table (level, target, achieved,
    time, result) instead of just a summary. *M.*
54. **First-run tutorial overlay** — a 30-second explainer for the pass/fail loop. *S.*

## 7. Accessibility

55. **Screen-reader live region on round change** — announce the new level and target.
    *S.*
56. **Colorblind-safe result colors** — pass/fail currently reads by color; add icons.
    *S.*
57. **Focus management in dialogs** — `SettingsDialog`, `SubmitRunForm`, and
    `AccountDialog` should trap and restore focus. *M.*
58. **Skip-reason dropdown as radio group** — proper labels, not a bare select. *S.*
59. **Minimum tap target sizes** on leaderboard rows. *S.*

## 8. Backend, data, and infrastructure

60. **Paginate the notifications feed** — it is unbounded and will get slow. *S.*
61. **Indexes on `runs(user_id, created_at)` and `submissions(status)`** — the stats
    dashboard and profile pagination both scan these. *S.*
62. **Server-side run summary endpoint** — let external tools read verified results
    without scraping HTML. *M.*
63. **Rate-limit middleware in the worker** shared across authenticated routes. *M.*
64. **Soft-delete + restore UI for accounts** — delete is currently permanent from
    the user's point of view; add a 30-day restore window. *M.*
65. **Database backup export script** under `scripts/` alongside the migrate script.
    *S.*
66. **CI on pull requests** — run `npm test` and `npm run lint` automatically. *S.*
67. **Request validation shared between client and worker** — one schema module both
    sides import, so the two cannot drift. *M.*
68. **Structured logging in the worker** — makes the moderation log actually debuggable.
    *S.*

## 9. Anti-abuse and fairness

69. **Alt-account detection heuristics** — flag accounts with identical run patterns
    or same-device submission fingerprints, reviewed by a mod rather than auto-punished.
    *M.*
70. **Submission cooldown per user** — currently only the redeem flow has one; rate
    limit run submissions too. *S.*
71. **Proof freshness rule** — video must be uploaded after the run's `startedAt`, which
    the run already stores. *S.*
72. **Leaderboard minimum-evidence rule** — require a stated attempt count and a video
    host before an entry can be approved. *S.*

## 10. Bigger, longer-term

73. **Weekly featured list** — one curated list promoted on the home page each week,
    with its own mini leaderboard. *L, but very high engagement value.*
74. **Team challenges** — small groups share a run and combine percentages. Needs new
    tables and real-time sync. *L.*
75. **Discord bot** — mirror your profile, submit runs, and post results from Discord.
    *L.*
76. **Run replay/sharing** — encode a finished run and let players load it as a
    "ghost" replay. *L.*
77. **Achievement + title system** — see #31; extends into season titles. *M → L.*
78. **Public API with keys** — approved runs readable via a token, for third-party
    stat trackers. *M.*
79. **Full changelog page instead of a dialog** — `ChangelogDialog.jsx` becomes a route
    so entries are linkable. *S.*
80. **Multiplayer seed rooms** — two players draw from the identical level sequence
    and race. Needs authoritative server state. *L.*

---

## Suggested order

**Quick wins (S, high value):** #1, #42(pause via localStorage → #2), #21, #26,
#44, #45, #50, #61, #69, #72.

**Next tier (M):** #17, #25, #27, #34, #37, #42, #53, #60–#62, #67.

**Later (L):** #73, #74, #76, #78, #80.

**Free wins:** #54 (search before starting), #48, #49, #51, #79 — each is mostly UI
work on files that already exist.
