# Preview.7 separate-session usage trial

Tested `0.1.0-preview.7` at tag `v0.1.0-preview.7`, commit `d6d4942ee965fb33745e47113274e524f9e10b46`. The isolated worktree was clean, origin was fetched, and the tag was checked out detached. Installed CLI and package versions match.

**Command execution passed; semantic summary was partial. Usable savings credit: 0 tokens.**

- Host verification: skill current, matching release hash, unowned (`owned=false`).
- Initial delegate status: enabled, automatic monitor enabled, monitor closed, GPU lock free, no active jobs. Historical jobs are excluded.
- Exactly one health check passed on the cold path. The existing offload setting produced a warning; preferences and guards were unchanged.
- `--print-platform --json` passed: supported Windows x64 / PowerShell; relevant support tiers full.
- `shape "Summarize the exported functions in src/delegate/ledger.js without changing files" --no-model --json` passed with `passthrough`, `needs_shaping`, `reason=no_model`, `modelCall=false` and 46 ms duration.

## Local job and verification

One `delegate ask` used `--max-output 600` on `src/hosts/install.js` and `src/delegate/ledger.js`. The exact task and all command statuses are in the companion JSON.

| Measurement | Result |
|---|---:|
| Job ID | `20260919-200522-ask-d5088f` |
| Command status | `ok` |
| Actual local input / output / total tokens | 5967 / 210 / 6177 |
| Estimated prompt tokens | 6231 |
| Duration | 32808 ms (ledger rounds to 32.8 s) |
| Source characters | 16933 (9640 + 7293) |
| Returned answer / summary characters | 993 / 993 |
| Returned JSON envelope characters | 1624 |
| Targeted source excerpts read | 15016 characters |
| Selected ledger record read | 233 characters |

The response contained eight bullets, proposed no changes and was not truncated. Full source contents were not read into the host context before delegation. Two targeted reads verified the claims; character counts include file/line prefixes and newlines.

Semantic findings:
- The host exports and preservation/hash ownership claims were supported by `verifyHostSkills`, `buildHostInstallStep` and `buildHostUninstallPlan`. Ownership comes from a matching manifest entry; `createdBy` records origin, and uninstall also checks the hash.
- All six ledger exports were omitted: `parseSince`, `appendLedger`, `parseLedger`, `readLedger`, `summarizeLedger`, `renderLedgerText`.
- The response misleadingly described avoided paid tokens and omitted flooring. `summarizeLedger` explicitly describes an estimate of source-input reduction, not measured billing.
- The response overstated grouping: job/status counts are grouped by command/status; token and duration totals are global.

No second model job was run to repair the partial result.

## Accounting

The ledger formula, per qualifying entry, is `floor(max(0, toCount(localInputChars) - toCount(summaryChars)) / 3.5)`, summed across entries with a valid timestamp in range and status `ok`, `dry_run` or `applied`. `estimatedPaidTokensAvoided` is only a legacy alias. This trial's raw text reduction is **4554 estimated tokens before overhead**, with **no usable savings credit** for the uncorrected partial summary.

The requested net estimate is:

```text
floor(max(0, sourceChars - summaryChars - handoffPromptChars
  - envelopeCharsBeyondSummary - verificationReadChars
  - skillReadChars - preflightReadChars) / 3.5)

floor(max(0, 16933 - 993 - 316 - 631 - 15249 - 6769 - 57375) / 3.5) = 0
```

Counts use UTF-16 code units. Handoff includes the complete ask command (task text alone: 203 characters). Verification includes the source excerpts and selected ledger record. Preflight includes the initial inventory, tool discovery metadata, ancestor instructions/version/help, checkout metadata, host verification, status, platform, shape and health outputs; the JSON records each component. The estimate conservatively includes repeated human-readable/JSON payloads and the instruction file read.

**Actual cloud billing savings are unmeasured without a matched baseline.** This is neither whole-session savings nor a currency estimate. Inherited context, tool wrappers, commentary, evidence writing and final artifact checks are outside this limited calculation; counting them cannot improve its zero result. Support-tier labels do not prove every command works. Requested CLI operations can create their own runtime records.

Only these two project artifacts were written; production sources were unchanged. No retry, alternate runner, guard override, preference/Unity process change, commit, push or publishing was performed. Follow-up: treat the summary as partial; do not credit the misleading billing wording as completed work.
