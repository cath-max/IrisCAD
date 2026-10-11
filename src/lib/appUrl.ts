const configuredAppOrigin = () =>
  (import.meta.env.VITE_APP_URL as string | undefined)
    ?.trim()
    .replace(/\/+$/, '') || '';

export function getAppRedirectUrl(path: string): string {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const origin =
    configuredAppOrigin() ||
    (typeof window !== 'undefined' ? window.location.origin : '');

  if (!origin) return `${basePath}${path}`;
  return `${origin}${basePath}${path}`;
}

/** Preserve a legacy Cloud Run deep link while moving it to IrisCAD's domain. */
export function getCanonicalBrowserUrl(): string | null {
  if (typeof window === 'undefined') return null;

  const canonicalOrigin = configuredAppOrigin();
  if (!canonicalOrigin || !window.location.hostname.endsWith('.run.app')) {
    return null;
  }

  const canonical = new URL(canonicalOrigin);
  if (window.location.origin === canonical.origin) return null;

  return `${canonical.origin}${window.location.pathname}${window.location.search}${window.location.hash}`;
}
