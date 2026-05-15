export const REG_DATETIME = /(\d{4}-\d{2}-\d{2}T\d+:\d+)/u;
export const REG_DATE = /(\d{4}-\d{2}-\d{2})/u;

export function isDatetimeString(value: string): boolean {
  return REG_DATETIME.test(value);
}

export function momentToISODateOnly(value: string): string {
  return window.moment(value).format('YYYY-MM-DD');
}

export function toGoogleDueISO(value: string): string {
  if (isDatetimeString(value)) {
    return window.moment(value).toISOString();
  }
  return window.moment(value + 'T12:00:00').toISOString();
}

export function toGoogleCompletedISO(doneDateTime: string | null | undefined): string | undefined {
  if (!doneDateTime) return new Date().toISOString();
  return toGoogleDueISO(doneDateTime);
}
