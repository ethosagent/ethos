import {
  CATALOG_KINDS,
  CATALOG_PIN_TYPES,
  CATALOG_TIERS,
  type CatalogEntry,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  type CatalogEntrySchema,
  CatalogKindSchema,
  CatalogPinSchema,
  CatalogTierSchema,
} from '../schema/catalog';

// `CatalogEntry` (packages/types/src/catalog.ts) and `CatalogEntrySchema` (the
// wire shape) are two hand-kept descriptions of one object. These compile-time
// assertions fail typecheck if either gains, loses or retypes a field the
// other does not; the runtime cases pin the enum option lists to the `as const`
// vocabularies.
type Wire = z.infer<typeof CatalogEntrySchema>;
const wireToType = (e: Wire): CatalogEntry => e;
const typeToWire = (e: CatalogEntry): Wire => e;

describe('CatalogEntry wire drift', () => {
  it('the interface and z.infer are mutually assignable (compile-time)', () => {
    expect(typeof wireToType).toBe('function');
    expect(typeof typeToWire).toBe('function');
  });

  it('kind options equal CATALOG_KINDS', () => {
    expect([...CatalogKindSchema.options]).toEqual([...CATALOG_KINDS]);
  });

  it('tier options equal CATALOG_TIERS', () => {
    expect([...CatalogTierSchema.options]).toEqual([...CATALOG_TIERS]);
  });

  it('pin discriminator options equal CATALOG_PIN_TYPES', () => {
    expect([...CatalogPinSchema.options.map((o) => o.shape.type.value)]).toEqual([
      ...CATALOG_PIN_TYPES,
    ]);
  });
});
