// Money values must never round a real non-zero amount to a visual zero. Keep the normal compact
// precision for ordinary values, then extend only far enough to include the first meaningful
// digits for tiny balances/fees. EVM native values can have up to 18 decimal places.
export function formatAdaptiveAmount(value, {
  minDecimals = 3,
  significantDigits = 3,
  maxDecimals = 18,
  fallback = '—',
} = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed === 0) return parsed.toFixed(minDecimals);

  const magnitude = Math.abs(parsed);
  const leadingFractionZeros = magnitude < 1
    ? Math.max(0, Math.ceil(-Math.log10(magnitude)) - 1)
    : 0;
  const decimals = Math.min(maxDecimals, Math.max(minDecimals,
    leadingFractionZeros + significantDigits));
  const fixed = parsed.toFixed(decimals);
  const [whole, fraction = ''] = fixed.split('.');
  if (!fraction) return whole;
  const trimmed = fraction.replace(/0+$/, '');
  const kept = trimmed.padEnd(minDecimals, '0');
  return kept ? `${whole}.${kept}` : whole;
}

export function formatSignedAdaptiveAmount(value, options) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return options?.fallback ?? '—';
  if (parsed === 0) return formatAdaptiveAmount(0, options);
  return `${parsed < 0 ? '−' : '+'}${formatAdaptiveAmount(Math.abs(parsed), options)}`;
}
