export const IRIS_STATIC_LOGO = 'iris-logo-256.webp';
export const IRIS_ACTIVE_LOGO = 'iris-agent-active.webp';

export function resolveIrisLogoAsset(active: boolean, reducedMotion: boolean) {
  return active && !reducedMotion ? IRIS_ACTIVE_LOGO : IRIS_STATIC_LOGO;
}
