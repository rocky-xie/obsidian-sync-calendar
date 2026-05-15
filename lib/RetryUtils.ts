import { API_RETRY_MAX, API_RETRY_DELAY_MS } from 'lib/Constants';
import { debug } from 'lib/DebugLog';
import { gfSyncStatus$, gfNetStatus$ } from 'Syncs/StatusEnumerate';
import { SyncStatus, NetworkStatus } from 'Syncs/StatusEnumerate';

export async function retryOperation<T>(
  operation: () => Promise<T>,
  onSuccess: (result: T) => void,
  label: string,
  maxRetries: number = API_RETRY_MAX,
  delayMs: number = API_RETRY_DELAY_MS,
): Promise<void> {
  gfSyncStatus$.next(SyncStatus.UPLOAD);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      onSuccess(result);
      gfSyncStatus$.next(SyncStatus.SUCCESS_WAITING);
      gfNetStatus$.next(NetworkStatus.HEALTH);
      return;
    } catch (error) {
      debug(`Error on ${label} (attempt ${attempt}/${maxRetries}): ${error}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  gfSyncStatus$.next(SyncStatus.FAILED_WARNING);
  gfNetStatus$.next(NetworkStatus.CONNECTION_ERROR);
  throw new Error(`Failed to ${label} after ${maxRetries} attempts`);
}
