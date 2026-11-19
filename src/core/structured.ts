export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function field(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = asRecord(value)?.[key];
  return value;
}

export function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
