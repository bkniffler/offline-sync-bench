/** Shared by the server wiring and published benchmark metadata. */
export const serverDatabaseProfile = {
  driver: 'postgres-js',
  poolSize: 10,
} as const;
