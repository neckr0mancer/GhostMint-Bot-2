const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function finiteInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
export function parseLocalDateTime(value) {
  const match = LOCAL_DATE_TIME_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match;
  const year = finiteInteger(yearText);
  const month = finiteInteger(monthText);
  const day = finiteInteger(dayText);
  const hour = finiteInteger(hourText);
  const minute = finiteInteger(minuteText);
  const second = finiteInteger(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23
    || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  // Date normalizes impossible wall-clock values (31 February, DST gaps, and similar). Reject
  // those rather than returning a different instant from the one visibly chosen by the user.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  return date;
}

export function localDateTimeValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function startOfCalendarMonth(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

export function addCalendarDays(value, amount) {
  const date = value instanceof Date ? value : new Date(value);
  const days = finiteInteger(amount);
  if (Number.isNaN(date.getTime()) || days === null) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days,
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

export function addCalendarMonths(value, amount) {
  const date = value instanceof Date ? value : new Date(value);
  const months = finiteInteger(amount);
  if (Number.isNaN(date.getTime()) || months === null) return null;
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1,
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

export function calendarMonthDays(value) {
  const month = startOfCalendarMonth(value);
  if (!month) return [];
  const first = addCalendarDays(month, -month.getDay());
  return Array.from({ length:42 }, (_, index) => addCalendarDays(first, index));
}

export function sameCalendarDay(left, right) {
  if (!(left instanceof Date) || !(right instanceof Date)
    || Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function calendarDayBefore(left, right) {
  if (!(left instanceof Date) || !(right instanceof Date)
    || Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  const leftDay = new Date(left.getFullYear(), left.getMonth(), left.getDate()).getTime();
  const rightDay = new Date(right.getFullYear(), right.getMonth(), right.getDate()).getTime();
  return leftDay < rightDay;
}

export function combineLocalDateAndTime(date, { hour, minute, second } = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const h = finiteInteger(hour);
  const m = finiteInteger(minute);
  const s = finiteInteger(second);
  if (h === null || h < 0 || h > 23 || m === null || m < 0 || m > 59
    || s === null || s < 0 || s > 59) return null;
  const combined = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, s, 0);
  return combined.getFullYear() === date.getFullYear() && combined.getMonth() === date.getMonth()
    && combined.getDate() === date.getDate() && combined.getHours() === h
    && combined.getMinutes() === m && combined.getSeconds() === s ? combined : null;
}

export function clampLocalDateTime(value, minimum) {
  const date = value instanceof Date ? value : parseLocalDateTime(value);
  const min = minimum instanceof Date ? minimum : parseLocalDateTime(minimum);
  if (!date) return min ? new Date(min.getTime()) : null;
  if (min && date.getTime() < min.getTime()) return new Date(min.getTime());
  return new Date(date.getTime());
}

export function pickerDisplayValue(value, locale) {
  const date = value instanceof Date ? value : parseLocalDateTime(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    weekday:'short', year:'numeric', month:'short', day:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
  }).format(date);
}
