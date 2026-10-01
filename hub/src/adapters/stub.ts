import type { Family, FamilyDescriptor } from '@house/shared'
import type { Adapter } from './types.ts'

/** Placeholder until the family's real adapter lands. Fails loudly, never silently. */
export function stub(family: Family, label: string, tagline: string): Adapter {
  const notReady = `The ${label} adapter is not available in this build`
  return {
    family,
    describe(): FamilyDescriptor {
      return { id: family, label, tagline, kinds: [], fields: [], pathKinds: [], defaultPort: null, capabilities: [], notes: [notReady] }
    },
    capabilities: () => [],
    probe: async () => ({ ok: false, latencyMs: null, error: notReady }),
    execute: async () => ({ ok: false, error: notReady }),
  }
}
