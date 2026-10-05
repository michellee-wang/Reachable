<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { client, IMPACTS, type Impact, type Scan } from './client'
import ReportView from './ReportView.vue'

/**
 * Reachable's single-view app. Paste a URL, start a scan, watch it progress
 * live, read the report, print it. No sign-in — the scanId returned by startScan
 * is the capability that lets this browser read and subscribe to its own scan.
 */

type Phase = 'idle' | 'starting' | 'running' | 'done' | 'failed'

const url = ref('')
const phase = ref<Phase>('idle')
const scan = ref<Scan | null>(null)
const errorMsg = ref('')
const pagesDone = ref(0)

let sub: { unsubscribe: () => void } | null = null
let pageSub: { unsubscribe: () => void } | null = null
const seenDone = new Set<string>()

function reset() {
  sub?.unsubscribe()
  pageSub?.unsubscribe()
  sub = null
  pageSub = null
  seenDone.clear()
  pagesDone.value = 0
  scan.value = null
  errorMsg.value = ''
  phase.value = 'idle'
}

/** The Scan counters are written once at the end, so live progress comes from
 *  each Page flipping to done or failed. */
function noteDone(page: { id: string; status?: string | null }) {
  if (page.status !== 'done' && page.status !== 'failed') return
  if (seenDone.has(page.id)) return
  seenDone.add(page.id)
  pagesDone.value = seenDone.size
}

async function start() {
  if (!url.value.trim()) return
  phase.value = 'starting'
  errorMsg.value = ''
  try {
    const { data, errors } = await client.mutations.startScan({ url: url.value.trim() })
    if (errors?.length || !data?.scanId) {
      throw new Error(errors?.[0]?.message ?? 'Could not start the scan.')
    }
    watchScan(data.scanId)
  } catch (e) {
    phase.value = 'failed'
    errorMsg.value = e instanceof Error ? e.message : String(e)
  }
}

/** Catch pages that finished before the subscription was listening. */
async function syncDone(scanId: string) {
  const { data } = await client.models.Scan.get({ id: scanId })
  if (!data) return
  const { data: pageRows } = await data.pages()
  for (const page of pageRows ?? []) noteDone(page)
}

/** Subscribe to the one scan we just started and mirror its live state. */
function watchScan(scanId: string) {
  phase.value = 'running'
  sub = client.models.Scan.onUpdate({ filter: { id: { eq: scanId } } }).subscribe({
    next: (updated) => {
      scan.value = updated
      if (updated.status === 'done') {
        phase.value = 'done'
        void syncDone(scanId)
      } else if (updated.status === 'failed') {
        phase.value = 'failed'
        errorMsg.value = updated.error ?? 'The scan failed.'
      }
    },
    error: (err: unknown) => {
      phase.value = 'failed'
      errorMsg.value = err instanceof Error ? err.message : 'Lost connection to the scan.'
    },
  })
  pageSub = client.models.Page.onUpdate({ filter: { scanId: { eq: scanId } } }).subscribe({
    next: (page) => noteDone(page),
  })
  // Prime the view immediately (the first onUpdate may be a moment away).
  void client.models.Scan.get({ id: scanId }).then(({ data }) => {
    if (data && !scan.value) scan.value = data
  })
  void syncDone(scanId)
}

onUnmounted(() => {
  sub?.unsubscribe()
  pageSub?.unsubscribe()
})

function print() {
  window.print()
}

const total = computed(() => {
  const s = scan.value
  if (!s) return 0
  return (
    (s.criticalCount ?? 0) + (s.seriousCount ?? 0) + (s.moderateCount ?? 0) + (s.minorCount ?? 0)
  )
})

const progressPct = computed(() => {
  const discovered = scan.value?.pagesDiscovered ?? 0
  if (!discovered) return 0
  return Math.min(100, Math.round((pagesDone.value / discovered) * 100))
})

const statusLabel = computed(() => {
  switch (scan.value?.status) {
    case 'crawling':
      return 'Finding pages…'
    case 'scanning':
      return 'Scanning pages…'
    case 'summarizing':
      return 'Writing plain-English fixes…'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return 'Starting…'
  }
})

function impactCount(impact: Impact): number {
  const s = scan.value
  if (!s) return 0
  return (s[`${impact}Count` as const] as number | null) ?? 0
}
</script>

<template>
  <main class="wrap">
    <header>
      <h1>Reachable</h1>
      <p class="tagline">
        Paste a URL. We scan up to ~200 public pages for common accessibility
        issues and rank what to fix first. Not a WCAG certification.
      </p>
    </header>

    <!-- Start form -->
    <form v-if="phase === 'idle' || phase === 'starting'" class="start" @submit.prevent="start">
      <label for="url" class="sr-only">Website URL</label>
      <input
        id="url"
        v-model="url"
        type="url"
        placeholder="https://example.org"
        required
        :disabled="phase === 'starting'"
        autocomplete="url"
      />
      <button type="submit" :disabled="phase === 'starting' || !url.trim()">
        {{ phase === 'starting' ? 'Starting…' : 'Scan' }}
      </button>
    </form>

    <!-- Live progress -->
    <section v-else-if="phase === 'running'" class="progress" aria-live="polite">
      <p class="status">{{ statusLabel }}</p>
      <div
        class="bar"
        role="progressbar"
        :aria-valuenow="progressPct"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="fill" :style="{ width: progressPct + '%' }" />
      </div>
      <p class="counts">
        {{ pagesDone }} / {{ scan?.pagesDiscovered ?? 0 }} pages scanned
      </p>
    </section>

    <!-- Report -->
    <section v-else-if="phase === 'done' && scan" class="report">
      <div class="report-head no-print">
        <h2>Report for {{ url }}</h2>
        <div class="actions">
          <button type="button" @click="print">Print / Save PDF</button>
          <button type="button" class="secondary" @click="reset">New scan</button>
        </div>
      </div>

      <div class="summary">
        <span class="total">{{ total }} issue{{ total === 1 ? '' : 's' }}</span>
        <ul class="impact-pills">
          <li v-for="impact in IMPACTS" :key="impact" :class="['pill', impact]">
            {{ impactCount(impact) }} {{ impact }}
          </li>
        </ul>
      </div>

      <ReportView v-if="scan.id" :scan-id="scan.id" />
    </section>

    <!-- Failure -->
    <section v-else-if="phase === 'failed'" class="failed" role="alert">
      <p>{{ errorMsg || 'Something went wrong.' }}</p>
      <button type="button" @click="reset">Try again</button>
    </section>
  </main>
</template>

<style scoped>
.wrap {
  max-width: 820px;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  font: 16px/1.5 system-ui, sans-serif;
  color: #1a1a1a;
}
h1 {
  margin: 0;
  font-size: 2rem;
}
.tagline {
  color: #555;
  margin: 0.25rem 0 2rem;
}
.start {
  display: flex;
  gap: 0.5rem;
}
.start input {
  flex: 1;
  padding: 0.7rem 0.9rem;
  font-size: 1rem;
  border: 1px solid #bbb;
  border-radius: 8px;
}
button {
  padding: 0.7rem 1.1rem;
  font-size: 1rem;
  border: 0;
  border-radius: 8px;
  background: #1a56db;
  color: #fff;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button.secondary {
  background: #e5e7eb;
  color: #1a1a1a;
}
.progress {
  margin-top: 1rem;
}
.status {
  font-weight: 600;
}
.bar {
  height: 14px;
  background: #e5e7eb;
  border-radius: 7px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: #1a56db;
  transition: width 0.4s ease;
}
.counts {
  color: #555;
  font-size: 0.9rem;
}
.report-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
.summary {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin: 1rem 0;
}
.total {
  font-size: 1.25rem;
  font-weight: 700;
}
.impact-pills {
  display: flex;
  gap: 0.5rem;
  list-style: none;
  padding: 0;
  margin: 0;
  flex-wrap: wrap;
}
.pill {
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
}
.pill.critical {
  background: #fde8e8;
  color: #9b1c1c;
}
.pill.serious {
  background: #fdf0e3;
  color: #9a5b00;
}
.pill.moderate {
  background: #fdf6b2;
  color: #7a6500;
}
.pill.minor {
  background: #e1effe;
  color: #1e429f;
}
.failed {
  margin-top: 1rem;
  padding: 1rem;
  background: #fde8e8;
  color: #9b1c1c;
  border-radius: 8px;
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
@media print {
  .no-print {
    display: none;
  }
}
</style>
