<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { client, IMPACTS, loadScanPages, type Impact, type Scan } from './client'
import ReportView from './ReportView.vue'

/**
 * Reachable's single-view app. Paste a URL, start a scan, watch it progress
 * live, read the report, print it. No sign-in — the scanId returned by startScan
 * is the capability that lets this browser read and subscribe to its own scan.
 */

type Phase = 'idle' | 'starting' | 'running' | 'done' | 'failed'

const url = ref('')
const urlInput = ref<HTMLInputElement | null>(null)
const phase = ref<Phase>('idle')
const scan = ref<Scan | null>(null)
const errorMsg = ref('')
const pagesDone = ref(0)

let sub: { unsubscribe: () => void } | null = null
let pageSub: { unsubscribe: () => void } | null = null
const seenDone = new Set<string>()

function dropSubs() {
  sub?.unsubscribe()
  pageSub?.unsubscribe()
  sub = null
  pageSub = null
  seenDone.clear()
  pagesDone.value = 0
}

function reset() {
  dropSubs()
  scan.value = null
  errorMsg.value = ''
  phase.value = 'idle'
  void nextTick(() => urlInput.value?.focus())
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
  dropSubs()
  phase.value = 'starting'
  errorMsg.value = ''
  scan.value = null
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
  try {
    for (const { page } of await loadScanPages(scanId)) noteDone(page)
  } catch {
    /* live updates still arrive through the subscription */
  }
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
        dropSubs()
      }
    },
    error: (err: unknown) => {
      phase.value = 'failed'
      errorMsg.value = err instanceof Error ? err.message : 'Lost connection to the scan.'
      dropSubs()
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

const discovered = computed(() => scan.value?.pagesDiscovered ?? 0)

const progressPct = computed(() => {
  if (!discovered.value) return 0
  return Math.min(100, Math.round((pagesDone.value / discovered.value) * 100))
})

const statusLabel = computed(() => {
  switch (scan.value?.status) {
    case 'crawling':
      return 'Finding pages'
    case 'scanning':
      return 'Scanning pages'
    case 'summarizing':
      return 'Writing fixes'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    default:
      return 'Starting'
  }
})

function impactCount(impact: Impact): number {
  const s = scan.value
  if (!s) return 0
  return (s[`${impact}Count` as const] as number | null) ?? 0
}
</script>

<template>
  <main :class="phase === 'done' ? 'doc' : 'stage'">
    <div :class="phase === 'done' ? 'sheet' : 'hero'">
      <header v-if="phase !== 'done'">
        <h1>Reachable</h1>
        <p class="lede">Scan up to 200 public pages and rank what to fix first.</p>
      </header>

      <p v-if="phase === 'failed'" class="error" role="alert">
        {{ errorMsg || 'Something went wrong.' }}
      </p>

      <form v-if="phase === 'idle' || phase === 'failed'" class="start" @submit.prevent="start">
        <label for="url" class="sr-only">Website URL</label>
        <input
          id="url"
          ref="urlInput"
          v-model="url"
          type="url"
          name="url"
          placeholder="https://example.org"
          required
          autofocus
          autocomplete="url"
          spellcheck="false"
        />
        <button type="submit" :disabled="!url.trim()">Scan</button>
      </form>

      <section
        v-else-if="phase === 'starting' || phase === 'running'"
        class="progress"
        aria-live="polite"
      >
        <p id="scan-status" class="status">{{ statusLabel }}</p>
        <div
          class="bar"
          role="progressbar"
          :aria-valuenow="discovered ? progressPct : undefined"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuetext="statusLabel"
          aria-labelledby="scan-status"
        >
          <div
            class="fill"
            :class="{ indeterminate: !discovered }"
            :style="discovered ? { width: progressPct + '%' } : undefined"
          />
        </div>
        <p v-if="discovered" class="counts">{{ pagesDone }} of {{ discovered }} pages</p>
      </section>

      <section v-else-if="phase === 'done' && scan" class="report">
        <p class="mark">Reachable</p>
        <div class="report-head">
          <div>
            <h1>{{ scan.domain }}</h1>
            <p v-if="url" class="scanned">{{ url }}</p>
          </div>
          <div class="actions no-print">
            <button type="button" @click="print">Print</button>
            <button type="button" class="secondary" @click="reset">New scan</button>
          </div>
        </div>

        <div class="summary">
          <p class="total">
            {{ total }}
            {{ total === 1 ? 'issue' : 'issues' }}
          </p>
          <ul class="impacts">
            <li v-for="impact in IMPACTS" :key="impact">
              <span :class="['badge', impact]">{{ impact }}</span>
              <span class="num">{{ impactCount(impact) }}</span>
            </li>
          </ul>
        </div>

        <ReportView v-if="scan.id" :scan-id="scan.id" />
      </section>
    </div>
  </main>
</template>

<style>
body {
  margin: 0;
  background: #fff;
  color: #171717;
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  color-scheme: light;
}
</style>

<style scoped>
.stage {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1.25rem;
  box-sizing: border-box;
}

.hero {
  width: min(32rem, 100%);
}

.doc {
  padding: 3rem 1.25rem 5rem;
}

.sheet {
  width: min(42rem, 100%);
  margin: 0 auto;
}

h1 {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.2;
}

.lede {
  margin: 0.6rem 0 1.75rem;
  color: #3f3f46;
}

.start {
  display: flex;
  gap: 0.5rem;
}

.start input {
  flex: 1;
  min-width: 0;
  height: 2.75rem;
  padding: 0 0.8rem;
  font: inherit;
  color: #171717;
  background: #fff;
  border: 1px solid #a3a3a3;
  border-radius: 6px;
  box-sizing: border-box;
}

.start input::placeholder {
  color: #525252;
}

button {
  height: 2.75rem;
  padding: 0 1rem;
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: #171717;
  border: 1px solid #171717;
  border-radius: 6px;
  cursor: pointer;
}

button:disabled {
  color: #525252;
  background: #e5e5e5;
  border-color: #e5e5e5;
  cursor: default;
}

button.secondary {
  color: #171717;
  background: #fff;
}

button:focus,
.start input:focus {
  outline: 2px solid #171717;
  outline-offset: 2px;
}

.error {
  margin: 0 0 1rem;
  color: #7f1d1d;
}

.progress {
  display: grid;
  gap: 0.65rem;
}

.status {
  margin: 0;
  font-weight: 600;
}

.bar {
  height: 4px;
  background: #e5e5e5;
  border-radius: 999px;
  overflow: hidden;
}

.fill {
  height: 100%;
  background: #171717;
  border-radius: inherit;
  transition: width 0.4s ease;
}

.fill.indeterminate {
  width: 35%;
  animation: slide 1.1s ease-in-out infinite;
}

.counts {
  margin: 0;
  color: #3f3f46;
}

.mark {
  margin: 0 0 1.25rem;
  font-size: 0.875rem;
  font-weight: 600;
}

.report-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.25rem;
}

.scanned {
  margin: 0.4rem 0 0;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.summary {
  margin: 2rem 0 1.5rem;
}

.total {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.impacts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  list-style: none;
  padding: 0;
  margin: 0.85rem 0 0;
}

.impacts li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  padding: 0.12rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  text-transform: capitalize;
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

@media (max-width: 560px) {
  .start,
  .report-head,
  .actions {
    flex-direction: column;
    align-items: stretch;
  }

  .actions button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
  .fill.indeterminate {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}

@keyframes slide {
  from {
    transform: translateX(-120%);
  }
  to {
    transform: translateX(320%);
  }
}

@media print {
  .no-print {
    display: none;
  }
  .doc {
    padding: 0;
  }
}
</style>
