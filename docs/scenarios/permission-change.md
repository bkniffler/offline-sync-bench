# Permission-change convergence

This scenario measures how long it takes for rows from one revoked project to disappear while rows for still-authorized projects remain visible.

## Workload

- seed one organization with multiple projects, users, memberships, and tasks
- bootstrap one client into a multi-project local cache
- revoke that client’s membership for one of the visible projects on the server
- measure how long it takes until the local cache removes rows for the revoked project while retaining rows for the other authorized project

## Primary metrics

- `initial_visible_rows`
- `post_revoke_visible_rows`
- `revoked_project_visible_rows_after_revoke`
- `retained_project_visible_rows_after_revoke`
- `permission_revoke_convergence_ms`
- `bytes_transferred`

## Interpretation

- This is a native auth/scoping benchmark, not a UI-side filtering benchmark.
- A stack should be marked `unsupported` unless the benchmark path is exercising a real product-supported permission-revocation flow.
- A correct result should converge to:
  - `revoked_project_visible_rows_after_revoke = 0`
  - `retained_project_visible_rows_after_revoke > 0`

## Current harness notes

- Syncular is measured natively through real server-side scope resolution and local revocation handling.
- Electric is measured through an auth-scoped benchmark app that derives the effective project filter from `project_memberships` and re-bootstraps the actor-scoped shape after revocation.
