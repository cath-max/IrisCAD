/**
 * Iris Credits are enforced by default. Local development must opt out
 * explicitly so a missing production variable can never disable charging.
 */
export function areIrisCreditsEnabled(
  configuredValue: string,
  environment: string,
): boolean {
  const normalizedValue = configuredValue.trim().toLowerCase();
  if (normalizedValue === 'true') return true;
  if (normalizedValue === 'false') return false;
  return environment.trim().toLowerCase() !== 'local';
}
