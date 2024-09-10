
export function getEnv(key: string) {
  const rawValue = process.env[key];
  if (!rawValue) {
    throw new Error(`Environment Variable "${key}" not found.`);
  }
  return rawValue;
}



