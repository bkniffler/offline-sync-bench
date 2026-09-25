# Sync responsiveness

100,000-task cold bootstrap, then 20,000 server-side task updates delivered to the live client. Chromium 1234 on Apple M4. Medians of completed trials; milliseconds unless marked.

## Default priority

| Client | Bootstrap | Input p95 | Input max | Main thread blocked | Longest frame | Screen query p95 | Catch-up | Input p95 | Input max | Main thread blocked | Idle input p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Syncular JS | 413 | 9.10 | 9.10 | 0.00% | 0.00 | 78.0 | 1128 | 16.5 | 16.5 | 0.00% | 15.2 |
| PowerSync | 6553 | 15.7 | 16.7 | 0.00% | 0.00 | 1921 | 2475 | 15.2 | 15.6 | 0.00% | 15.4 |
| Zero | 1962 | 432 | 444 | 24.4% | 530 | 0.03 | 3104 | 339 | 441 | 16.6% | 15.7 |
| Electric | 854 | 94.2 | 94.2 | 24.8% | 120 | 6.90 | 839 | 84.6 | 84.6 | 22.2% | 15.3 |
| Electric + TanStack DB | 1858 | 642 | 642 | 62.8% | 738 | 0.08 | 2554 | 808 | 850 | 71.0% | 15.0 |

## Low CPU priority (slower device)

| Client | Bootstrap | Input p95 | Input max | Main thread blocked | Longest frame | Screen query p95 | Catch-up | Input p95 | Input max | Main thread blocked | Idle input p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Syncular JS | 1381 | 15.4 | 15.4 | 0.00% | 0.00 | 850 | 3807 | 15.7 | 16.3 | 0.00% | 15.4 |
| PowerSync | 21822 | 15.4 | 17.1 | 0.00% | 0.00 | 79.5 | 10239 | 14.9 | 16.9 | 0.00% | 14.8 |
| Zero | 3030 | 1509 | 1609 | 52.9% | 1665 | 0.12 | 4992 | 1634 | 1836 | 44.2% | 14.7 |
| Electric | 2551 | 444 | 505 | 70.5% | 512 | 27.0 | 3055 | 426 | 522 | 68.5% | 15.6 |
| Electric + TanStack DB | 6714 | 3291 | 3595 | 86.8% | 3659 | 0.16 | 9853 | 2926 | 3329 | 88.2% | 15.2 |

Calibration (fixed integer loop, ms, main thread / worker): Syncular JS default 9.48 / 9.43; PowerSync default 9.44 / 9.23; Zero default 9.50 / 9.19; Electric default 9.47 / 9.26; Electric + TanStack DB default 9.62 / 9.26; Syncular JS low-priority 35.4 / 43.5; PowerSync low-priority 38.6 / 35.0; Zero low-priority 32.9 / 38.7; Electric low-priority 34.6 / 40.7; Electric + TanStack DB low-priority 44.8 / 49.1
