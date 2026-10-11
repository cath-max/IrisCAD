export function env(name: string): string {
  return process.env[name] ?? '';
}

export function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
