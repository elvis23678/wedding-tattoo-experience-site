
export const SCHEDULER_JOB_NAMES = Object.freeze([
  'workflow_sync',
  'guest_activation',
  'guest_finalization',
  'balance_due',
  'event_completion',
  'practice_archival'
]);

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  intervalMinutes: 15,
  batchSize: 100,
  guestCloseDaysBeforeEvent: 15,
  balanceDueDaysBeforeEvent: 7,
  archiveDaysAfterEvent: 30,
  lockSeconds: 900
});

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function schedulerConfigFromEnv(env = process.env) {
  return {
    enabled: String(env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
    intervalMinutes: integer(
      env.SCHEDULER_INTERVAL_MINUTES,
      DEFAULT_SCHEDULER_CONFIG.intervalMinutes,
      1,
      1440
    ),
    batchSize: integer(
      env.SCHEDULER_BATCH_SIZE,
      DEFAULT_SCHEDULER_CONFIG.batchSize,
      1,
      1000
    ),
    guestCloseDaysBeforeEvent: integer(
      env.GUEST_CLOSE_DAYS_BEFORE_EVENT,
      DEFAULT_SCHEDULER_CONFIG.guestCloseDaysBeforeEvent,
      1,
      120
    ),
    balanceDueDaysBeforeEvent: integer(
      env.BALANCE_DUE_DAYS_BEFORE_EVENT,
      DEFAULT_SCHEDULER_CONFIG.balanceDueDaysBeforeEvent,
      1,
      120
    ),
    archiveDaysAfterEvent: integer(
      env.ARCHIVE_DAYS_AFTER_EVENT,
      DEFAULT_SCHEDULER_CONFIG.archiveDaysAfterEvent,
      0,
      3650
    ),
    lockSeconds: integer(
      env.SCHEDULER_LOCK_SECONDS,
      DEFAULT_SCHEDULER_CONFIG.lockSeconds,
      30,
      3600
    )
  };
}

export function schedulerIntervalMs(config) {
  return Math.max(60_000, Number(config.intervalMinutes) * 60_000);
}

export function schedulerRuleSummary(config) {
  return {
    guestSelectionCloses:
      `${config.guestCloseDaysBeforeEvent} giorni prima dell’evento`,
    balanceBecomesDue:
      `${config.balanceDueDaysBeforeEvent} giorni prima dell’evento`,
    practiceArchives:
      `${config.archiveDaysAfterEvent} giorni dopo l’evento`,
    scanInterval:
      `ogni ${config.intervalMinutes} minuti`
  };
}
