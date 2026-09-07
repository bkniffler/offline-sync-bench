# First revised publication: pilot and decision rules

The first report will cover the current eight native-host adapters across the seven RFC suites. Browser and packet-network measurements remain separate profiles with existing correctness evidence. The first report will link that coverage and its limitations; it will not present those single-trial diagnostics as performance comparisons. Browser performance publication still needs repeated measurements and loaded instrumentation checks.

## Pilot declared before collection

`campaigns/variability-pilot.json` declares three independent trials for every adapter in six workload families: initial startup, collaboration, ordinary offline replay, local screens, connected fanout and access revocation. This is 144 planned attempts in seeded randomized blocks. Fixtures, warmups, sizes, client counts, timeouts and the fixed 20-second recovery outage use the existing contracts. No implementation changes are allowed during collection.

These cases sample the core timing paths. They do not estimate variability of every extension: restart, conflicts, larger queues, relationship screens, reconnect backlogs, replica reopen and attachments still need their own independent publication trials. Pilot failures and missing metrics remain visible. Partial output from a failed attempt cannot supply a successful latency estimate.

Three observations are too few for a reliable confidence interval. Review each adapter/case/metric independently using its trial median, range and `(maximum - minimum) / median`. Compare variation only within one compatible profile. Retain the complete attempt roster, sample values and provenance in a pilot analysis artifact.

The primary pilot metrics are first-screen/full-data startup times, local-commit/server-acceptance/reader-visibility p50, queue drain/reader visibility, list/search query p50, all-reader fanout completion and online/offline access convergence. Missing local acknowledgment stays unavailable.

## Fixed publication count

After all pilot attempts finish, choose one count for the whole native publication campaign:

- Use **10 independent trials per case** if any primary metric with three successful trials has a range above 50% of its median and above twice the absolute practical threshold below.
- Otherwise use **five independent trials per case**. Metrics without three successful pilot observations remain explicitly unassessed for variability; five is the minimum design, not a claim of adequate precision.

This is a bounded design rule, not a power calculation. Commit the pilot review and final configuration before collecting publication samples. Use a new seed and fresh campaign. Do not combine pilot and publication samples, append favorable retries, or keep sampling until an ordering appears. Failed attempts count toward the declared number. A source change invalidates pooling across that change and requires a separately declared campaign.

The final configuration will include startup/reopen, collaboration, replay/scaling/restart, both conflict cases, both local-screen cases, connected fanout/reconnect backlog, access revocation and attachments. Include unavailable cases in the roster. Preserve Jazz's experimental lane and all persistence, queue-ownership, query-strategy and access-guarantee distinctions.

## Uncertainty and practical significance

Publish trial-level medians and the existing 95% bootstrap interval only with at least five successful independent trials. Flag a full interval width above 25% of the median as imprecise in both the main page and companion. A missing interval means uncertainty is unavailable, not zero. If the fixed campaign remains imprecise, publish that limitation rather than silently adding trials.

For editorial selection, a latency difference must exceed **both 20% and the applicable absolute threshold** before describing it as practically meaningful:

| Application question | Absolute threshold |
| --- | --- |
| Loaded local screen or local write acknowledgment | 1 ms |
| Server acceptance or another client's visibility | 5 ms |
| First screen, full dataset or replica reopening | 100 ms |
| Offline convergence, client recovery or access convergence | 100 ms |
| Attachment completion | 100 ms |

These are report conventions for this benchmark, not universal user-perception limits. Smaller effects can be reported numerically without a practical superiority claim. An interval overlapping another estimate does not by itself prove equality, and separate marginal intervals do not establish a formal pairwise significance test. Imprecise observations can still support an honest failure or scaling investigation; they cannot support a confident speed ordering.

Correctness failures, unavailable guarantees and conflicting outcomes require no latency threshold to merit a finding. Resource and traffic differences need an explicit application consequence and measurement scope; do not turn them into an overall score.

## Publication review

Select three to five findings after inspecting the complete campaign. Bind every selected finding to all its case's attempts, including failures, and label its explanation as confirmed, supported hypothesis or unexplained. Where no controlled experiment or direct accounting establishes a cause, name the next discriminating experiment. Historical investigations may motivate that experiment but cannot become evidence about a changed implementation without review.

Each chart must identify workload, units, profile, independent trial counts and uncertainty. Keep the main report near 1,000 to 1,500 words. The companion retains all measurements and outcomes. Run the publication gate, verify relocated artifacts, inspect the rendered charts/report and audit the RFC before marking implementation complete.
