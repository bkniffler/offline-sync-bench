/** Workload groups for reports; scale is a case parameter, not a separate suite. */
export const suites = [
  { id: 'startup', title: 'Startup', question: 'How quickly can someone start working?', cases: ['bootstrap', 'replica-reopen'] },
  { id: 'collaboration', title: 'Collaboration', question: 'How responsive is collaboration?', cases: ['online-propagation'] },
  { id: 'offline-recovery', title: 'Offline recovery', question: 'Does offline work survive and converge?', cases: ['offline-replay', 'large-offline-queue', 'offline-restart', 'conflict-update-update', 'conflict-update-delete'] },
  { id: 'local-screens', title: 'Local screens', question: 'Can it serve realistic screens locally?', cases: ['local-query', 'deep-relationship-query'] },
  { id: 'client-recovery', title: 'Client fanout and recovery', question: 'What happens when many clients return?', cases: ['connected-fanout', 'reconnect-storm'] },
  { id: 'access', title: 'Access revocation', question: 'Does access revocation remove the right data?', cases: ['permission-change'] },
  { id: 'attachments', title: 'Attachments', question: 'How do attachments behave?', cases: ['blob-flow'], optional: true },
] as const;
