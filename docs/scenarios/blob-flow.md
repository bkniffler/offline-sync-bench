# Blob Flow

This scenario measures a real cross-client blob workflow: writer upload,
metadata sync onto an application row that another client can observe, and an
authenticated re-download through the product blob APIs.

## Workload

1. Seed a small authenticated Syncular project dataset.
2. Start a writer and reader client with the blob plugin enabled.
3. Upload one `512 KiB` blob with `immediate: true`.
4. Sync blob metadata onto a shared task row.
5. Wait until the reader sees that metadata locally.
6. Clear the uploader cache.
7. Re-download the blob on the uploader through `client.blobs.retrieve(...)`.

## Metrics

- `blob_size_bytes`
- `upload_complete_ms`
- `metadata_visible_ms`
- `download_after_metadata_ms`
- `request_count`
- `request_bytes`
- `response_bytes`
- `bytes_transferred`
- `cache_bytes_after_upload`
- `cache_bytes_after_download`
- `avg_memory_mb`
- `peak_memory_mb`
- `avg_cpu_pct`
- `peak_cpu_pct`

## Notes

- The benchmark uses the real Syncular blob plugin and real blob server routes.
- Request and byte counts include upload init, signed upload, completion,
  metadata sync, and the authenticated re-download path.
- Other stacks should stay `unsupported` unless the blob workflow is directly
  comparable without benchmark-owned glue.
