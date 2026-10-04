import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../amplify/data/resource'

/**
 * The public data client. Reachable has no accounts: every call uses the public
 * API key baked into amplify_outputs.json. The key can only read a scan by id
 * and subscribe to it (no list, no writes) — starting a scan goes through the
 * startScan mutation.
 */
export const client = generateClient<Schema>({ authMode: 'apiKey' })

export type Scan = Schema['Scan']['type']
export type Page = Schema['Page']['type']
export type Violation = Schema['Violation']['type']

/** The impact levels, in the order the report ranks them. */
export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const
export type Impact = (typeof IMPACTS)[number]
