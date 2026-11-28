import type { ToolResult } from '@ethosagent/types';

export type ToolFailure = Extract<ToolResult, { ok: false }>;

export function invalid(error: string, field?: string): ToolFailure {
  return field === undefined
    ? { ok: false, code: 'input_invalid', error }
    : { ok: false, code: 'input_invalid', error, field };
}

export function refused(error: string): ToolFailure {
  return { ok: false, code: 'not_available', error };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The args object, or an `input_invalid` failure. */
export function argsRecord(args: unknown): Record<string, unknown> | ToolFailure {
  return isRecord(args) ? args : invalid('arguments must be an object');
}

/** A non-empty string field, or an `input_invalid` failure naming it. */
export function reqString(a: Record<string, unknown>, field: string): string | ToolFailure {
  const v = a[field];
  return typeof v === 'string' && v.trim().length > 0
    ? v
    : invalid(`${field} must be a non-empty string`, field);
}

export function optString(
  a: Record<string, unknown>,
  field: string,
): string | undefined | ToolFailure {
  const v = a[field];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : invalid(`${field} must be a string`, field);
}

export function reqNumber(a: Record<string, unknown>, field: string): number | ToolFailure {
  const v = a[field];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? v
    : invalid(`${field} must be a non-negative number`, field);
}

export function stringList(a: Record<string, unknown>, field: string): string[] | ToolFailure {
  const v = a[field];
  if (!Array.isArray(v) || v.length === 0) {
    return invalid(`${field} must be a non-empty array of strings`, field);
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      return invalid(`${field} must contain only non-empty strings`, field);
    }
    out.push(item);
  }
  return out;
}

/** Narrowing for a parsed field that is either a value or a failure. */
export function failed<T>(v: T | ToolFailure): v is ToolFailure {
  return typeof v === 'object' && v !== null && 'ok' in v && v.ok === false;
}
