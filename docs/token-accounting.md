# Delegation token accounting

`opencode-unity delegate ledger --json` separates measured local-model usage from estimated reduction of source text sent to an orchestrating model.

| Field | Meaning |
| --- | --- |
| `promptTokens`, `outputTokens` | Ollama-reported token counts for recorded jobs, including failed work where counts exist. |
| `usableLocalTokens` | Local input plus output tokens for successful, validated or applied results. It is local work, not measured cloud savings. |
| `localInputChars`, `summaryChars` | Source characters supplied locally and summary characters returned to the calling agent. |
| `estimatedInputTokensAvoided` | Sum of `floor(max(0, localInputChars - summaryChars) / 3.5)` for usable jobs. Failed and partial jobs receive zero credit. |
| `estimatedPaidTokensAvoided` | Compatibility alias for the same estimate; its name does not imply measured billing. |

This estimate assumes the caller would otherwise read all named source files. It excludes the handoff prompt, command envelope, verification excerpts, review, retries, cached inputs and differences between tokenizers. A task-specific report should subtract those additional characters before estimating a net input reduction. Returning more text than the source yields no positive savings credit. A refused job yields zero measured local tokens and zero savings credit.

Actual cloud token or monetary savings require a matched baseline, cloud usage records, tokenizer and billing/cache information. Local token counts alone cannot supply that comparison. Reports must label source-text estimates and measured counts separately; percentages apply only to the stated workload, never to the entire development session.

The separate-session release trial is recorded in the [completion status](completion-plan.md). A busy Unity Editor can prevent an eligible local task from starting; such a refusal is reported without retrying automatically or weakening the guard.
