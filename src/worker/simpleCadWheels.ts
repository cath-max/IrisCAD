/**
 * Wheel filenames hosted under `public/vendor/simplecadapi/`.
 * Keep in sync with copied files under `public/vendor/simplecadapi/`.
 * `npm run setup:local` / `setup:wheels` rewrites these names automatically.
 */
export const SIMPLECADAPI_OCP_WHEEL =
  'cadquery_ocp_novtk_ocp_wasm-7.9.3.1.post202607021200-cp314-cp314-pyemscripten_2026_0_wasm32.whl';

export const SIMPLECADAPI_PACKAGE_WHEEL =
  'simplecadapi-2.0.1b8-py3-none-any.whl';

const CHINA_TIME_ZONE = 'Asia/Shanghai';

function primarySimpleCadWheelUrl(filename: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return new URL(
    `${base}vendor/simplecadapi/${filename}`,
    window.location.origin,
  ).href;
}

function chinaMirrorSimpleCadWheelUrl(filename: string): string | null {
  const configuredBase = import.meta.env
    .VITE_SIMPLECAD_WHEEL_CHINA_MIRROR_BASE_URL;
  if (!configuredBase) return null;
  return `${configuredBase.replace(/\/?$/, '/')}${filename}`;
}

function prefersChinaMirror(): boolean {
  try {
    // A VPN changes the exit IP, but not the user's browser time zone. This
    // keeps mainland users on the nearby mirror without adding a geo API to
    // the critical path.
    return Intl.DateTimeFormat().resolvedOptions().timeZone === CHINA_TIME_ZONE;
  } catch {
    return false;
  }
}

/** Ordered install candidates. micropip falls through after a failed source. */
export function simpleCadWheelCandidateUrls(filename: string): string[] {
  const primary = primarySimpleCadWheelUrl(filename);
  const mirror = chinaMirrorSimpleCadWheelUrl(filename);
  const ordered =
    mirror && prefersChinaMirror()
      ? [mirror, primary]
      : mirror
        ? [primary, mirror]
        : [primary];
  return [...new Set(ordered)];
}
