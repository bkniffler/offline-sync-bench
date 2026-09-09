# Collection interruptions

The corrected SQL campaign retains its fixed plan and three attempts per case. Every saved result remains counted, including the Turso disk failures and PowerSync setup failures. Recovery never reruns a saved attempt. These events change service and cache history; they do not recreate an uninterrupted experiment.

| Point in collection | Observation and recovery |
| --- | --- |
| Turso 25-reader setup | Two attempts reported no storage space. Idle stores and old working copies were archived, unused build intermediates removed, and retired evidence compressed with byte verification. The failures remain in the results. |
| After 69 attempts | Disk headroom was below the precautionary threshold. The paused controller later exited. After space was freed, recovery verified the saved results, plan, source, dependencies, runtime, images and Rust executable before continuing at 70. |
| After 79 attempts | The controller exited between cases. Recovery restored the original PATH from this task's shell snapshot and reproduced the original environment fingerprint. A detached controller continued at 80. The exit cause is unknown. |
| After 88 attempts | A Docker configuration inspection failed after the bootstrap result was saved. On inspection, OrbStack was stopped. The existing daemon and containers were started with retained volumes. Recovery preserved the invalid manifest and continued at 89 after verification. Why OrbStack stopped is unknown. |

The [storage maintenance record](../../results/diagnostics/publication-index-review/MAINTENANCE-PAUSE.json), [compression record](../../results/diagnostics/publication-index-review/EVIDENCE-COMPRESSION.json), and recovery records after [69](../../results/diagnostics/tuned-v017-recovery/RECOVERY.json), [79](../../results/diagnostics/tuned-v017-recovery/gap-0079/RECOVERY.json) and [88](../../results/diagnostics/tuned-v017-recovery/gap-0088/RECOVERY.json) retain the evidence. The 7 GiB launch threshold is precautionary; it does not guarantee that a whole attempt fits.

## Empty DNS settings after Docker recovery

The two Turso containers' inspected HostConfig hashes differed after the daemon outage. Exactly three fields had changed from `null` to `[]`: `Dns`, `DnsOptions` and `DnsSearch`. Replacing only those fields in an inspection copy reproduces each original HostConfig hash and the full original configuration fingerprint. All other recorded settings remain checked.

The installed engine's [DNS option handling](https://github.com/moby/moby/blob/daa0cb7f/daemon/container_operations.go#L60-L74) applies each override only when its list has entries. Both representations therefore specify no container override. The recovery checker permits only this recorded equivalence for these two containers; nonempty DNS settings or another configuration change fail verification. It changes no container DNS settings or measured query code.

The [offline verification](../../results/diagnostics/tuned-v017-recovery/gap-0088/OFFLINE-VERIFICATION.json) reproduces the two actual hashes from archived inputs and rejects three nonempty DNS overrides plus another runtime change. [Original configuration](../../results/diagnostics/tuned-v017-recovery/gap-0088/ORIGINAL-CONFIGURATION.json), [observed configuration](../../results/diagnostics/tuned-v017-recovery/gap-0088/OBSERVED-CONFIGURATION.json), [raw HostConfig inputs](../../results/diagnostics/tuned-v017-recovery/gap-0088/HOST-CONFIGS.json), [checker source](../../results/diagnostics/tuned-v017-recovery/gap-0088/configuration-checker.ts.txt) and the [launch receipt](../../results/diagnostics/tuned-v017-recovery/gap-0088/LAUNCH.json) preserve the exception. Service restarts and default resolver/cache state remain environmental limitations.
