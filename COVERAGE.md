## Coverage and outcomes

Replacement collection: **177/177 attempts**. H marks retained historical coverage from the stopped campaign.

| Suite | Syncular | Syncular Rust Client | Electric | Electric + TanStack DB | Zero | PowerSync | Turso Sync | Jazz v2 (experimental) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Startup | 2 passed | 2 passed | 2 passed | 2 passed H | 2 passed | 2 passed | 2 passed; 1 failed attempt | 1 timed-out; 1 passed H; 5 failed attempts |
| Collaboration | 1 passed | 1 passed | 1 passed H | 1 passed H | 1 passed H | 1 passed | 1 passed | 1 passed H |
| Offline recovery | 5 passed | 5 passed | 5 passed H | 5 passed | 4 passed; 1 unsupported H | 5 passed | 5 passed | 4 passed; 1 timed-out H; 5 failed attempts |
| Local screens | 2 passed | 2 passed | 2 passed | 2 passed H | 2 passed | 2 passed | 2 passed | 2 passed |
| Client fanout and recovery | 2 passed | 2 passed | 2 passed H | 2 passed H | 2 passed H | 2 passed | 2 passed; 2 failed attempts | 2 passed H |
| Access revocation | 1 passed | 1 passed | 1 passed H | 1 passed H | 1 passed H | 1 passed | 1 not implemented | 1 timed-out H; 4 failed attempts |
| Attachments | 1 passed | 1 passed | 1 not implemented H | 1 not implemented H | 1 not implemented H | 1 not implemented | 1 not implemented | 1 not implemented H |

Cells summarize the latest outcome per case; replacement cases remain pending until their declared attempts are recorded. Failed-attempt counts include earlier failures. H cases retain their original attempts and are not new tuned comparisons. Jazz v2 remains experimental. Unavailable coverage makes no claim about product capabilities.

This combines coverage only. Timings, annotations and uncertainty stay with their source campaign. [Source and trial identities](./COVERAGE.json).
