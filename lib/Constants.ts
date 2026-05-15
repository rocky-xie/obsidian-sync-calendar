export const API_RETRY_MAX = 20;
export const API_RETRY_DELAY_MS = 100;
export const FETCH_TIMEOUT_MS = 4000;
export const HASH_TRUNCATE_LENGTH = 16;

export const NETWORK_STATUS = {
  UNKNOWN: '⚫',
  HEALTHY: '🟢',
  ERROR: '🔴',
} as const;

export const SYNC_STATUS = {
  UNKNOWN: '⚫',
  UPLOAD: '🔼',
  DOWNLOAD: '🔽',
  FAILED: '🆖',
  SUCCESS: '🆗',
} as const;

export const EVENT_STATUS_PREFIX = {
  CANCELLED: '🚫',
  IMPORTANT: '❗️',
  DEFERRED: '💤',
  QUESTION: '❓',
  DONE: '✅',
} as const;
