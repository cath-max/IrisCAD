export function isIrisCreationRoute(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized === '/';
}

export function isIrisWorkspaceRoute(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return normalized.startsWith('/editor/') || normalized.startsWith('/share/');
}
