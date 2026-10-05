/**
 * Plain-English fixes, one per axe rule.
 *
 * The same rule fails on many elements and pages, so we explain each ruleId
 * once and reuse the text. A model error on one rule is skipped: the report
 * still ships, and the UI falls back to axe's own description for that rule.
 */

export interface RuleToExplain {
  ruleId: string;
  help?: string | null;
  description?: string | null;
}

/** Turns a rule into a short fix. Tests pass a fake; the handler passes Bedrock. */
export interface Explainer {
  explain(rule: RuleToExplain): Promise<string>;
}

// bounded-concurrency map: at most `limit` calls in flight at once
export async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Explain each distinct ruleId once. Blank or failed explanations are omitted
 * so the caller leaves those rows alone.
 */
export async function explainRules(
  explainer: Explainer,
  rules: RuleToExplain[],
): Promise<Map<string, string>> {
  const unique = new Map<string, RuleToExplain>();
  for (const rule of rules) {
    if (!unique.has(rule.ruleId)) unique.set(rule.ruleId, rule);
  }

  const fixes = new Map<string, string>();
  await mapPool([...unique.values()], 4, async (rule) => {
    try {
      const text = (await explainer.explain(rule)).trim();
      if (text) fixes.set(rule.ruleId, text);
    } catch {
      // One rule's failure must not drop the rest of the report.
    }
  });
  return fixes;
}
