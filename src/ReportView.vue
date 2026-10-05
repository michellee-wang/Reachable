<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { client, IMPACTS, type Impact, type Page, type Violation } from './client'

/**
 * The per-page report. Given a finished scan's id, loads its pages and each
 * page's violations by traversing the relationships (allowed with the public
 * key's get/listen — you must already hold the scanId to get here), then renders
 * them ranked by impact. The scanId is the capability; there is no list.
 */
const props = defineProps<{ scanId: string }>()

interface PageReport {
  page: Page
  violations: Violation[]
}

const loading = ref(true)
const pages = ref<PageReport[]>([])
const shots = ref<Record<string, string>>({})

/** Rank order so critical issues sort first within a page. */
function byImpact(a: Violation, b: Violation): number {
  const rank = (i: string | null | undefined) => {
    const idx = IMPACTS.indexOf((i ?? '') as Impact)
    return idx === -1 ? IMPACTS.length : idx
  }
  return rank(a.impact) - rank(b.impact)
}

onMounted(async () => {
  try {
    const { data: scan } = await client.models.Scan.get({ id: props.scanId })
    if (!scan) return
    const { data: pageRows } = await scan.pages()
    const reports = await Promise.all(
      (pageRows ?? []).map(async (page) => {
        const { data: violations } = await page.violations()
        return { page, violations: (violations ?? []).slice().sort(byImpact) }
      }),
    )
    // Pages with the most issues first; clean pages last.
    reports.sort((a, b) => b.violations.length - a.violations.length)
    pages.value = reports
    await Promise.all(
      reports.map(async ({ page }) => {
        const key = page.screenshotKey
        if (!key) return
        const { data } = await client.queries.screenshotUrl({ key })
        if (data) shots.value = { ...shots.value, [key]: data }
      }),
    )
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <p v-if="loading" class="loading">Loading report…</p>

  <div v-else class="pages">
    <article v-for="{ page, violations } in pages" :key="page.id" class="page">
      <h3>
        <a :href="page.url" target="_blank" rel="noopener">{{ page.url }}</a>
      </h3>

      <img
        v-if="page.screenshotKey && shots[page.screenshotKey]"
        class="shot"
        :src="shots[page.screenshotKey]"
        :alt="'Screenshot of ' + page.url"
      />

      <p v-if="page.status === 'failed'" class="page-failed">
        This page couldn't be scanned.
      </p>
      <p v-else-if="violations.length === 0" class="page-clean">No issues found.</p>

      <ul v-else class="violations">
        <li v-for="(v, i) in violations" :key="v.id ?? i" class="violation">
          <div class="v-head">
            <span :class="['badge', v.impact ?? 'minor']">{{ v.impact ?? 'unknown' }}</span>
            <span class="rule">{{ v.help ?? v.ruleId }}</span>
          </div>
          <p v-if="v.plainEnglishFix" class="fix">{{ v.plainEnglishFix }}</p>
          <p v-else-if="v.description" class="desc">{{ v.description }}</p>
          <code v-if="v.html" class="target">{{ v.html }}</code>
          <code v-else-if="v.target" class="target">{{ v.target }}</code>
          <a
            v-if="v.helpUrl"
            class="learn no-print"
            :href="v.helpUrl"
            target="_blank"
            rel="noopener"
            >Learn more</a
          >
        </li>
      </ul>
    </article>
  </div>
</template>

<style scoped>
.loading {
  color: #555;
}
.page {
  border-top: 1px solid #e5e7eb;
  padding: 1rem 0;
}
.page h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  word-break: break-all;
}
.page h3 a {
  color: #1a56db;
}
.shot {
  display: block;
  max-width: 100%;
  margin: 0.25rem 0 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.page-clean {
  color: #046c4e;
  margin: 0;
}
.page-failed {
  color: #9b1c1c;
  margin: 0;
}
.violations {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.75rem;
}
.violation {
  background: #f9fafb;
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
}
.v-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.rule {
  font-weight: 600;
}
.badge {
  text-transform: capitalize;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
}
.badge.critical {
  background: #fde8e8;
  color: #9b1c1c;
}
.badge.serious {
  background: #fdf0e3;
  color: #9a5b00;
}
.badge.moderate {
  background: #fdf6b2;
  color: #7a6500;
}
.badge.minor {
  background: #e1effe;
  color: #1e429f;
}
.fix,
.desc {
  margin: 0.4rem 0 0.3rem;
}
.desc {
  color: #444;
}
.target {
  display: block;
  font-size: 0.8rem;
  background: #eef0f3;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  overflow-x: auto;
}
.learn {
  display: inline-block;
  margin-top: 0.4rem;
  font-size: 0.85rem;
  color: #1a56db;
}
</style>
