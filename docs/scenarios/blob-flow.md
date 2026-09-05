# Blob Flow

This scenario measures cross-client blob upload, metadata propagation, first
reader download, and recovery of a pending upload after a transport outage.
The JS and native Rust adapters use the published Syncular blob APIs against
the same Postgres/MinIO server.

## Workload

1. Seed one project with 50 tasks and two authorized users.
2. Bootstrap a writer and reader subscribed to tasks and blob entries.
3. Stage a random 2 MiB blob with `uploadBlob`, reference it from a new
   `task_blob_entries` row, and sync the writer. The native queue uploads the
   bytes through a presigned MinIO PUT before pushing the referencing row.
4. Wait for the metadata row on the realtime reader, download the blob through
   the authenticated product API, and verify its bytes/content address.
5. Stage a different 2 MiB blob and its referencing row.
6. Inject transport failures for both the signed PUT and the authenticated
   direct PUT during one upload pass. Blocking only the signed PUT would let
   the product recover immediately through its other upload route.
7. Verify the failed upload remains in the native queue. Restore transport,
   sync again, verify the upload and commit queues drain, then verify the
   referencing row and correct blob bytes on the reader.

The injected outage happens before the PUT body reaches the network. This
measures retained-queue retry, not resuming a partially transmitted body or
restarting a client process. Recovery latency covers restored connectivity
through upload and writer sync completion; reader verification follows it.

## Metrics

- `blob_size_bytes`, `upload_complete_ms`, `metadata_visible_ms`
- `download_after_metadata_ms`, `hash_verified`
- `retry_first_attempt_ms`, `retry_recovery_ms`, `retry_failed_puts`
- `retry_pending_after_failure`, `retry_pending_after_recovery`, `retry_hash_verified`
- `request_count`, `request_bytes`, `response_bytes`, `bytes_transferred`
- `transfer_overhead_bytes`
- `sqlite_storage_bytes_after_upload`, `sqlite_storage_bytes_after_download`
- `sqlite_storage_overhead_bytes_after_upload`, `sqlite_storage_overhead_bytes_after_download`

Transfer counters exclude setup and the separate retry case. Transfer overhead
is body bytes for the first upload, metadata propagation and reader download,
minus two payload copies. Native Rust transport counters omit JSON bodies for
grant and redirect responses, so its overhead is explicitly shown as a lower
bound. HTTP headers and network framing are excluded in both adapters.

SQLite storage overhead is the increase in `page_count * page_size` on each
client, minus one payload. It includes local blob cache and metadata pages,
not MinIO or server-database storage.
