# Delegation measurement — 2026-09-19

This report separates a recorded successful local job from the new-session release trial. It does not measure cloud billing or the token cost of the entire release effort.

## Earlier successful job

Source: the local append-only delegation ledger, inspected with the corrected `delegate ledger --json` implementation. Job `20260919-160826-ask-bce603` completed before this release trial; it is not credited as work performed by the new session.

| Measurement | Value |
| --- | ---: |
| Status | `ok` |
| Named source files | 2 |
| Source characters supplied locally | 25,276 |
| Summary characters returned | 1,888 |
| Ollama input tokens | 9,170 |
| Ollama output tokens | 366 |
| Total measured local tokens | 9,536 |
| Duration | 58.8 seconds |
| Source characters omitted from the returned summary | 23,388 |
| Estimated source-input tokens avoided before overhead | 6,682 |
| Source-text reduction before overhead | 92.53% |

Calculation: `floor((25276 - 1888) / 3.5) = 6682`; character reduction is `(25276 - 1888) / 25276 * 100 = 92.53%`. This assumes the calling model would otherwise read both complete files. Handoff, envelope, skill loading and verification overhead for this historical job were not recorded, so its **net** savings and actual cloud billing savings are unmeasured.

The previous accounting implementation treated all 9,536 local tokens as estimated paid tokens avoided. The corrected ledger reports 9,536 as measured local work and 6,682 as estimated source-input reduction before overhead. These are different quantities.

## Separate-session trial

The [independent trial](separate-session-preview-7.md) used the installed preview.7 package in a fresh Codex session. Job `20260919-200522-ask-d5088f` passed the guard and completed in **32.808 seconds**, with **5,967 input + 210 output = 6,177 actual local tokens**.

It reduced 16,933 source characters to a 993-character answer: `floor((16933 - 993) / 3.5) = 4554` estimated source-input tokens before overhead. That is a text-size calculation, not usable or billed savings. Verification found omitted exports and misleading accounting wording, so the summary is **partial** and receives **zero usable savings credit**.

The requested net calculation includes 316 handoff characters, 631 additional envelope characters, 15,249 verification characters, 6,769 skill characters and 57,375 preflight characters. It gives **0 estimated net tokens avoided**. Preparing a new host session and checking this small summary cost more context than the source text it replaced. These results do not establish that all delegation loses tokens; they show why small jobs, extensive preparation and incomplete summaries must not be advertised as measured savings.

No second model job was run to repair the result. The delegation implementation tested in preview.7 is unchanged in preview.8; only version labels and test/documentation files changed afterward. Actual cloud billing savings remain unmeasured. The earlier successful job above is reported separately and is not credited to this trial.

See [the accounting contract](../token-accounting.md) for field definitions and limitations.
