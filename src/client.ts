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

/** The Page and Violation fields the app reads, as plain rows. The generated
 *  model types carry lazy loaders (`page.violations()`) that the public key
 *  cannot use, so related rows are fetched with the query below instead. */
export type PageRow = Pick<Page, 'id' | 'url' | 'status' | 'screenshotKey'>
export type ViolationRow = Pick<
  Violation,
  | 'id'
  | 'ruleId'
  | 'impact'
  | 'description'
  | 'help'
  | 'helpUrl'
  | 'target'
  | 'html'
  | 'screenshotKey'
  | 'plainEnglishFix'
>
export interface PageWithViolations {
  page: PageRow
  violations: ViolationRow[]
}

type Connection<T> = { items: (T | null)[]; nextToken: string | null } | null
type ViolationConn = Connection<ViolationRow>
type PageConn = Connection<PageRow & { violations: ViolationConn }>

const VIOLATION_FIELDS =
  'id ruleId impact description help helpUrl target html screenshotKey plainEnglishFix'

const SCAN_PAGES = /* GraphQL */ `
  query ScanPages($id: ID!, $nextToken: String) {
    getScan(id: $id) {
      pages(limit: 1000, nextToken: $nextToken) {
        nextToken
        items {
          id url status screenshotKey
          violations(limit: 1000) { nextToken items { ${VIOLATION_FIELDS} } }
        }
      }
    }
  }
`

const PAGE_VIOLATIONS = /* GraphQL */ `
  query PageViolations($id: ID!, $nextToken: String) {
    getPage(id: $id) {
      violations(limit: 1000, nextToken: $nextToken) { nextToken items { ${VIOLATION_FIELDS} } }
    }
  }
`

/**
 * Every page of a scan with its violations, in one or a few requests.
 *
 * This is a nested read under getScan. It is the only way the public key can
 * reach a scan's pages: the key has get/listen but not list, and the client's
 * relationship loaders (`scan.pages()`) are implemented as a filtered
 * listPages, which the API refuses. Nested connections ride the parent get,
 * so holding the scanId is still the only thing that opens a scan.
 */
export async function loadScanPages(scanId: string): Promise<PageWithViolations[]> {
  const pages: PageWithViolations[] = []
  let token: string | null = null
  do {
    const res = (await client.graphql({
      query: SCAN_PAGES,
      variables: { id: scanId, nextToken: token },
    })) as { data?: { getScan: { pages: PageConn } | null } }
    const conn = res.data?.getScan?.pages
    if (!conn) break
    for (const item of conn.items) {
      if (!item) continue
      const { violations: vConn, ...page } = item
      const violations = (vConn?.items ?? []).filter((v): v is ViolationRow => v !== null)
      let vToken = vConn?.nextToken ?? null
      while (vToken) {
        const more = (await client.graphql({
          query: PAGE_VIOLATIONS,
          variables: { id: page.id, nextToken: vToken },
        })) as { data?: { getPage: { violations: ViolationConn } | null } }
        const vc = more.data?.getPage?.violations
        if (!vc) break
        violations.push(...vc.items.filter((v): v is ViolationRow => v !== null))
        vToken = vc.nextToken
      }
      pages.push({ page, violations })
    }
    token = conn.nextToken
  } while (token)
  return pages
}
