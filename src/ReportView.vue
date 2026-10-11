<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { client, IMPACTS, loadScanPages, type Impact, type PageWithViolations } from './client'

/**
 * The report for one scan. Pages and violations come from one nested read
 * under getScan (get/listen is enough — you must already hold the scanId).
 * Issues are grouped by axe rule so the same failure is explained once;
 * the elements and screenshots stay inside the disclosure.
 */
const props = defineProps<{ scanId: string }>()

interface ElementHit {
  key: string
  snippet: string | null
  screenshotKey: string | null
  /** Same selector on every page collapses to one picture. */
  dedupe: string
  showShot: boolean
}

interface PageHit {
  url: string
  /** Older scans stored one viewport PNG on the page. */
  pageShotKey: string | null
  showPageShot: boolean
  elements: ElementHit[]
}

interface RuleGroup {
  ruleId: string
  impact: string
  title: string
  text: string | null
  helpUrl: string | null
  elementCount: number
  pages: PageHit[]
}

const loading = ref(true)
const rules = ref<RuleGroup[]>([])
const failedPages = ref<string[]>([])
const cleanCount = ref(0)
const loadError = ref('')
const shots = ref<Record<string, string>>({})

function impactRank(impact: string | null | undefined): number {
  const idx = IMPACTS.indexOf((impact ?? '') as Impact)
  return idx === -1 ? IMPACTS.length : idx
}

function elementLabel(count: number): string {
  return count === 1 ? '1 element' : `${count} elements`
}

/** Matches the scanner cap. A shared header should not become a gallery. */
const SHOTS_PER_RULE = 3

/** One group per axe rule, worst impact first. A fix is rule-level, so it is
 *  shown once. Element crops are capped per rule, and the same selector is
 *  shown once so a layout failure reads as one picture plus every page it hits. */
function groupByRule(reports: PageWithViolations[]): {
  rules: RuleGroup[]
  failed: string[]
  clean: number
} {
  const byRule = new Map<string, RuleGroup>()
  const failed: string[] = []
  let clean = 0

  for (const { page, violations } of reports) {
    if (page.status === 'failed') {
      failed.push(page.url)
      continue
    }
    if (page.status === 'done' && violations.length === 0) {
      clean++
      continue
    }
    for (const v of violations) {
      const ruleId = v.ruleId
      let group = byRule.get(ruleId)
      const impact = v.impact ?? 'unknown'
      if (!group) {
        group = {
          ruleId,
          impact,
          title: v.help?.trim() || ruleId,
          text: null,
          helpUrl: v.helpUrl ?? null,
          elementCount: 0,
          pages: [],
        }
        byRule.set(ruleId, group)
      } else if (impactRank(impact) < impactRank(group.impact)) {
        group.impact = impact
      }

      const fix = v.plainEnglishFix?.trim()
      if (fix) group.text = fix
      else if (!group.text && v.description?.trim()) group.text = v.description.trim()
      if (!group.helpUrl && v.helpUrl) group.helpUrl = v.helpUrl

      let hit = group.pages.find((p) => p.url === page.url)
      if (!hit) {
        hit = {
          url: page.url,
          pageShotKey: page.screenshotKey ?? null,
          showPageShot: false,
          elements: [],
        }
        group.pages.push(hit)
      }
      const snippet = v.html?.trim() || v.target?.trim() || null
      hit.elements.push({
        key: v.id ?? `${ruleId}-${group.elementCount}`,
        snippet,
        screenshotKey: v.screenshotKey ?? null,
        dedupe: v.target?.trim() || v.screenshotKey || snippet || `${ruleId}-${group.elementCount}`,
        showShot: false,
      })
      group.elementCount++
    }
  }

  const grouped = [...byRule.values()]
  for (const rule of grouped) {
    rule.pages.sort((a, b) => b.elements.length - a.elements.length)
    const seen = new Set<string>()
    let shown = 0
    for (const page of rule.pages) {
      const hasElementShot = page.elements.some((el) => el.screenshotKey)
      if (!hasElementShot && page.pageShotKey && shown < SHOTS_PER_RULE) {
        page.showPageShot = true
        shown++
        continue
      }
      for (const el of page.elements) {
        if (!el.screenshotKey || shown >= SHOTS_PER_RULE || seen.has(el.dedupe)) continue
        seen.add(el.dedupe)
        el.showShot = true
        shown++
      }
    }
  }
  grouped.sort(
    (a, b) => impactRank(a.impact) - impactRank(b.impact) || b.elementCount - a.elementCount,
  )
  return { rules: grouped, failed, clean }
}

onMounted(async () => {
  try {
    const reports = await loadScanPages(props.scanId)
    const grouped = groupByRule(reports)
    const resolved: Record<string, string> = {}
    const keys = new Set<string>()
    for (const rule of grouped.rules) {
      for (const page of rule.pages) {
        if (page.showPageShot && page.pageShotKey) keys.add(page.pageShotKey)
        for (const el of page.elements) {
          if (el.showShot && el.screenshotKey) keys.add(el.screenshotKey)
        }
      }
    }
    // A picture that cannot be signed (the Lambda is throttled while a big
    // scan runs, say) is dropped; the issue is still listed without it.
    await Promise.all(
      [...keys].map(async (key) => {
        try {
          const { data } = await client.queries.screenshotUrl({ key })
          if (data) resolved[key] = data
        } catch {
          /* no picture for this element */
        }
      }),
    )
    shots.value = resolved
    rules.value = grouped.rules
    failedPages.value = grouped.failed
    cleanCount.value = grouped.clean
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Could not load the report.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <p v-if="loading" class="loading">Loading the report…</p>

  <div v-else class="body">
    <p v-if="loadError" class="none" role="alert">Could not load the report. {{ loadError }}</p>
    <p v-else-if="rules.length === 0 && cleanCount > 0" class="none">
      No issues found on {{ cleanCount }} {{ cleanCount === 1 ? 'page' : 'pages' }}.
    </p>
    <p v-else-if="rules.length === 0 && failedPages.length === 0" class="none">
      No pages were scanned.
    </p>

    <div v-if="rules.length" class="rules">
      <article v-for="rule in rules" :key="rule.ruleId" class="rule">
        <details>
          <summary>
            <svg class="chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span :class="['badge', rule.impact]">{{ rule.impact }}</span>
            <span class="title">{{ rule.title }}</span>
            <span class="count">{{ elementLabel(rule.elementCount) }}</span>
          </summary>
          <div class="detail">
            <p v-if="rule.text" class="fix">{{ rule.text }}</p>
            <section v-for="page in rule.pages" :key="page.url" class="hit">
              <p class="page-url">
                <a :href="page.url" target="_blank" rel="noopener noreferrer">
                  {{ page.url }}
                  <span class="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
              <img
                v-if="page.showPageShot && page.pageShotKey && shots[page.pageShotKey]"
                class="shot"
                :src="shots[page.pageShotKey]"
                :alt="'Top of ' + page.url"
              />
              <ul class="elements">
                <li v-for="el in page.elements" :key="el.key">
                  <img
                    v-if="el.showShot && el.screenshotKey && shots[el.screenshotKey]"
                    class="shot"
                    :src="shots[el.screenshotKey]"
                    :alt="'Failing element on ' + page.url"
                  />
                  <code v-if="el.snippet">{{ el.snippet }}</code>
                </li>
              </ul>
            </section>
            <p v-if="rule.helpUrl" class="learn">
              <a :href="rule.helpUrl" target="_blank" rel="noopener noreferrer">
                Documentation for this rule
                <span class="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          </div>
        </details>
      </article>
    </div>

    <p v-if="rules.length && cleanCount" class="aside">
      {{ cleanCount }} {{ cleanCount === 1 ? 'page' : 'pages' }} with no issues.
    </p>

    <section v-if="failedPages.length" class="failed">
      <h2>Could not scan</h2>
      <ul>
        <li v-for="pageUrl in failedPages" :key="pageUrl">
          <a :href="pageUrl" target="_blank" rel="noopener noreferrer">
            {{ pageUrl }}
            <span class="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      </ul>
    </section>

    <p class="scope">This finds common issues. It does not certify WCAG compliance.</p>
  </div>
</template>

<style scoped>
.loading,
.none,
.aside,
.scope {
  margin: 0;
  color: #3f3f46;
}

.none {
  color: #171717;
  font-weight: 600;
}

.rules {
  margin-top: 0.25rem;
}

.rule {
  border-top: 1px solid #e7e7e7;
}

.rule:last-child {
  border-bottom: 1px solid #e7e7e7;
}

summary {
  display: grid;
  grid-template-columns: 1rem auto minmax(0, 1fr) auto;
  column-gap: 0.75rem;
  align-items: center;
  padding: 0.9rem 0.15rem;
  cursor: pointer;
  list-style: none;
}

summary::-webkit-details-marker {
  display: none;
}

summary:focus {
  outline: 2px solid #171717;
  outline-offset: 2px;
}

.chev {
  color: #171717;
  transition: transform 0.15s ease;
}

details[open] .chev {
  transform: rotate(90deg);
}

.title {
  font-weight: 600;
  min-width: 0;
}

.count {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.badge {
  display: inline-block;
  padding: 0.12rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: capitalize;
  justify-self: start;
}

.badge.critical {
  color: #7f1d1d;
  background: #fee2e2;
}
.badge.serious {
  color: #7c2d12;
  background: #ffedd5;
}
.badge.moderate {
  color: #713f12;
  background: #fef3c7;
}
.badge.minor {
  color: #1e3a8a;
  background: #dbeafe;
}
.badge.unknown {
  color: #171717;
  background: #f5f5f5;
}

.detail {
  padding: 0 0 1.25rem 1.75rem;
}

.fix {
  margin: 0 0 1rem;
  max-width: 65ch;
}

.hit + .hit {
  margin-top: 1.25rem;
}

.page-url {
  margin: 0 0 0.5rem;
  overflow-wrap: anywhere;
}

a {
  color: #171717;
  text-underline-offset: 2px;
}

a:focus {
  outline: 2px solid #171717;
  outline-offset: 2px;
}

.shot {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  max-height: 240px;
  margin: 0 0 0.45rem;
  border: 1px solid #e7e7e7;
  border-radius: 4px;
}

.elements {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.4rem;
}

code {
  display: block;
  padding: 0.45rem 0.6rem;
  overflow-x: auto;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.45;
  color: #171717;
  background: #f5f5f5;
  border-radius: 4px;
}

.learn {
  margin: 0.9rem 0 0;
}

.aside,
.failed,
.scope {
  margin-top: 1.75rem;
}

.failed h2 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}

.failed ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.failed li {
  overflow-wrap: anywhere;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .chev {
    transition: none;
  }
}

@media (max-width: 560px) {
  summary {
    grid-template-columns: 1rem auto minmax(0, 1fr);
    row-gap: 0.35rem;
  }
  .count {
    grid-column: 2 / -1;
    padding-left: 0.15rem;
  }
  .detail {
    padding-left: 0;
  }
}

@media print {
  details > :not(summary) {
    display: block !important;
  }
  .chev {
    display: none;
  }
}
</style>
