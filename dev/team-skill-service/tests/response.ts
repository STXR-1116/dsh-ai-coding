export async function bodyOf(response: Response): Promise<unknown> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return record.code === 0 && Object.hasOwn(record, 'data') ? record.data : value
}
