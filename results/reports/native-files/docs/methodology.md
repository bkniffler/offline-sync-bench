# Native attachments

One predeclared run per SDK (n=1), sequentially on local services. Each uploads two deterministic 2 MiB files linked to tasks and verifies their SHA-256 hashes after download. New processes and empty native stores serve the fresh and interrupted downloads. These are native file features, with different timing boundaries: PowerSync stages prepared bytes before timing its experimental native queue and streaming transport; Jazz times its native file helper including chunk creation and edge durability. PowerSync uses the same MinIO backend as Syncular and cuts a download after 64 KiB. Jazz drops its native connection after delivering a 256 KiB chunk, cancels the read, verifies an incomplete local file, then retries using the retained native cache. Both measure SDK calls and local materialization; hash validation follows the clock.

This is not a transport-only ranking. Run-to-run variability is unknown. Development runs and the campaign invalidated by a source change are excluded. All native state, interruption receipts and [provenance](../archive/files/RESULTS.json.gz) remain inspectable.

[Results](../RESULTS.md)
