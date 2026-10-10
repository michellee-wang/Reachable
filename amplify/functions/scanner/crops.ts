/**
 * Which failing elements get a screenshot.
 *
 * A clean page gets none. A rule can fail on dozens of nodes, and on a docs
 * site the same nav element fails on every page, so a crop of every node would
 * bring back a pile of near-identical pictures. The cap is per rule, per page:
 * the Map scans pages at the same time, so this step cannot share a counter
 * across the scan. The report applies the same cap again when it renders.
 */

export const CROPS_PER_RULE = 3;

export interface CropTarget {
  ruleId: string;
  nodeIndex: number;
  selector: string;
}

/**
 * A single CSS selector can be cropped. Axe's frame and shadow targets are a
 * list (or a nested list); those are left without a picture rather than
 * guessed into a selector that might match the wrong node.
 */
export function cssSelector(target: unknown): string | null {
  if (!Array.isArray(target) || target.length !== 1) return null;
  const only = target[0];
  if (typeof only !== "string") return null;
  const selector = only.trim();
  return selector === "" ? null : selector;
}

/** The first `cap` nodes of each rule that have a single CSS selector. */
export function nodesToCrop(
  violations: { id: string; nodes: { target: unknown }[] }[],
  cap = CROPS_PER_RULE,
): CropTarget[] {
  const out: CropTarget[] = [];
  for (const rule of violations) {
    let taken = 0;
    for (let nodeIndex = 0; nodeIndex < rule.nodes.length; nodeIndex++) {
      if (taken >= cap) break;
      const selector = cssSelector(rule.nodes[nodeIndex].target);
      if (!selector) continue;
      out.push({ ruleId: rule.id, nodeIndex, selector });
      taken++;
    }
  }
  return out;
}
