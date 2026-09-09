# Screen result verification

The [final review](../../../archive/files/results/diagnostics/publication-screen-review/FINAL.json.gz) verifies all **30 screen trials** from both completed campaigns: 24 SQL and six Zero trials. Every trial uses the canonical 100,000-task fixture and exact output checks, five warmups and 25 measured operations. Recorded percentiles reproduce from the samples.

SQL list, search and detail plans traverse matching indexes without an extra ordering step; dashboard sorting of project aggregates remains allowed. Zero records native filtering, ordering and relationships, with application aggregation identified explicitly. These checks establish the observed execution paths, not index optimality or causes of cross-product latency gaps.

The final review binds every result and the [reviewer source](reviewer.ts.txt). Earlier [12-trial](../../../archive/files/results/diagnostics/publication-screen-review/CHECKPOINT.json.gz), [16-trial](../../../archive/files/results/diagnostics/publication-screen-review/TWO-ROUND-CHECKPOINT.json.gz) and [24-trial](../../../archive/files/results/diagnostics/publication-screen-review/SQL-THREE-ROUND-CHECKPOINT.json.gz) checkpoints remain preserved. Reproduce with `bun scripts/review-tuned-screens.ts SQL_MANIFEST FINAL_OUTPUT ZERO_MANIFEST` using a new output path. This check supplements full publication and chart review.
