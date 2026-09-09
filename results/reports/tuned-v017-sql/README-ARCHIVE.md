# Restoring the publication

The readable report links to compressed raw evidence. [The artifact index](./ARCHIVE.json) records original and compressed byte counts and SHA-256 digests. The root RESULTS.json is a compact index; the complete manifest is preserved in the archive.

From this directory, restore the original publication into a new sibling directory:

```sh
python3 RESTORE.py restore . ../restored-publication
```

Restoration verifies every byte stream and preserves original paths, Markdown, reviewed annotations and file permissions. Regenerate the report from the restored RESULTS.json using the repository publication command. This packaging step does not replace the benchmark publication gate.
