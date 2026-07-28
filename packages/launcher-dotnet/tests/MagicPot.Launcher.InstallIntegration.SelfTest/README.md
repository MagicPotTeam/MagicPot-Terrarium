# InstallIntegration SelfTest

Uses only in-memory registry, shell-link, and filesystem adapters. It never opens HKCU and never creates a real shortcut. Covers exact inspection, partial crash recovery, conflict refusal, idempotence, and ownership-matched rollback (84 assertions).
