// Conditional processing: which profiled content a .ditaval file, or a hand
// picked set of values, leaves out of a preview.
//
// Host-neutral and DOM-free. The renderer
// already stamps every profiled element with `data-profile-keys`, a list of
// `attribute:value` pairs, and the stylesheet already hides anything carrying
// `.profile-filtered-out`. What was missing is the decision: does this
// element stay or go? That decision is here, so a host only has to read the
// attribute, ask `isExcluded`, and flip the class.
//
// The rules follow DITA-OT's filtering, which is what a .ditaval is written
// for:
//   - an element is judged attribute by attribute (audience, platform,
//     product, otherprops, props, and any attribute generalised through
//     `props="name(value ...)"`);
//   - for one attribute it is left out only when EVERY one of its values is
//     excluded -- `audience="internal admin"` stays if admin is not excluded;
//   - it is left out when ANY attribute leaves it out;
//   - a `<prop att="x" action=...>` with no `val` is the default for every
//     value of x that has no rule of its own; no rule at all means include.
// `flag`, `passthrough`, `<revprop>` and `<style-conflict>` never remove
// content and are read but ignored here.

import sax from 'sax';
import type { DitaNode } from './parser/domTypes';

/** attribute name -> its values, in document order. */
export type ProfileValues = Record<string, string[]>;

export type DitavalAction = 'include' | 'exclude' | 'flag' | 'passthrough';

export interface DitavalRule {
  att: string;
  /** Absent for the attribute-wide default. */
  val?: string;
  action: DitavalAction;
}

export interface Ditaval {
  rules: DitavalRule[];
  /** Set when the file was not well-formed; `rules` then holds what was read before the error. */
  error?: string;
}

export interface ProfileFilter {
  ditaval?: Ditaval;
  /** `attribute:value` pairs the reader turned off by hand. */
  hidden?: ReadonlySet<string>;
}

/**
 * The attributes the renderer records in data-profile-keys, in its order.
 * Kept in step with PROFILING_ATTRS in render/renderer.ts (not exported from
 * there); a test renders each one to catch drift.
 */
export const PROFILE_ATTRS = ['props', 'platform', 'product', 'audience', 'otherprops', 'base', 'importance', 'rev', 'status'] as const;

/**
 * Attributes a .ditaval never acts on: DITA-OT filters on audience, platform,
 * product, otherprops, props and their specialisations only. The rest are
 * still shown, and can still be turned off by hand.
 */
const NOT_DITAVAL_FILTERABLE = new Set(['base', 'importance', 'rev', 'status']);

const ACTIONS = new Set<string>(['include', 'exclude', 'flag', 'passthrough']);

/** The key a hand-picked value is stored under. */
export function profileKey(att: string, value: string): string {
  return `${att}:${value}`;
}

const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);

function add(out: ProfileValues, att: string, values: string[]): void {
  if (values.length === 0) return;
  (out[att] ??= []).push(...values);
}

/** `props` carries `name(value value)` groups for specialised attributes, plus bare values. */
function expandProps(raw: string, out: ProfileValues): void {
  const bare = raw.replace(/([^\s()]+)\(([^)]*)\)/g, (_m, name: string, values: string) => {
    add(out, name, tokens(values));
    return ' ';
  });
  add(out, 'props', tokens(bare));
}

/** The profiling values an element's attributes carry. */
export function profileValuesOf(attrs: Readonly<Record<string, string>> | undefined): ProfileValues {
  const out: ProfileValues = {};
  if (!attrs) return out;
  for (const name of PROFILE_ATTRS) {
    const raw = attrs[name];
    if (!raw || !raw.trim()) continue;
    if (name === 'props') expandProps(raw, out);
    else add(out, name, tokens(raw));
  }
  return out;
}

/**
 * The same values read back from a `data-profile-keys` attribute. The renderer
 * splits every attribute on whitespace, which cuts `props="platform(a b)"` in
 * two; joining an attribute's tokens again restores the original text.
 */
export function profileValuesOfKeys(keys: string | null | undefined): ProfileValues {
  const raw: Record<string, string[]> = {};
  for (const pair of (keys ?? '').split(',')) {
    const colon = pair.indexOf(':');
    if (colon <= 0) continue;
    let att: string;
    let value: string;
    try {
      att = decodeURIComponent(pair.slice(0, colon));
      value = decodeURIComponent(pair.slice(colon + 1));
    } catch {
      continue;
    }
    (raw[att] ??= []).push(value);
  }
  const attrs: Record<string, string> = {};
  for (const [att, values] of Object.entries(raw)) attrs[att] = values.join(' ');
  return profileValuesOf(attrs);
}

/** Read a .ditaval. Never throws: a broken file yields the rules before the break, and `error`. */
export function parseDitaval(xml: string): Ditaval {
  const rules: DitavalRule[] = [];
  let error: string | undefined;
  const parser = sax.parser(true, { trim: true });
  parser.onopentag = (node) => {
    if (node.name !== 'prop') return;
    const a = node.attributes as Record<string, string>;
    if (!a.att || !a.action || !ACTIONS.has(a.action)) return;
    const rule: DitavalRule = { att: a.att, action: a.action as DitavalAction };
    if (a.val !== undefined && a.val !== '') rule.val = a.val;
    rules.push(rule);
  };
  parser.onerror = (e) => {
    error ??= e.message.split('\n')[0];
    // Stop at the first error: what follows it cannot be trusted.
    parser.error = null as unknown as Error;
    parser.onopentag = undefined as unknown as typeof parser.onopentag;
  };
  try {
    parser.write(xml).close();
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e);
  }
  return error === undefined ? { rules } : { rules, error };
}

/** What a .ditaval says to do with one value of one attribute; `include` when it is silent. */
export function ditavalAction(ditaval: Ditaval | undefined, att: string, value: string): DitavalAction {
  if (!ditaval || NOT_DITAVAL_FILTERABLE.has(att)) return 'include';
  let fallback: DitavalAction = 'include';
  for (const rule of ditaval.rules) {
    if (rule.att !== att) continue;
    if (rule.val === value) return rule.action;
    if (rule.val === undefined) fallback = rule.action;
  }
  return fallback;
}

/** True when the filter would remove nothing, so a host can skip the work. */
export function isEmptyFilter(filter: ProfileFilter | undefined): boolean {
  if (!filter) return true;
  const ditavalActs = filter.ditaval?.rules.some((r) => r.action === 'exclude') ?? false;
  return !ditavalActs && (filter.hidden?.size ?? 0) === 0;
}

/** Is a value left out, by the file or by hand? */
export function isValueExcluded(filter: ProfileFilter, att: string, value: string): boolean {
  return filter.hidden?.has(profileKey(att, value)) === true || ditavalAction(filter.ditaval, att, value) === 'exclude';
}

/** Would an element carrying these profiling values be left out? */
export function isExcluded(values: ProfileValues, filter: ProfileFilter | undefined): boolean {
  if (isEmptyFilter(filter)) return false;
  const f = filter as ProfileFilter;
  for (const [att, list] of Object.entries(values)) {
    if (list.length > 0 && list.every((v) => isValueExcluded(f, att, v))) return true;
  }
  return false;
}

export interface ProfileGroup {
  att: string;
  values: string[];
}

/**
 * The attributes and values to offer in a filter panel: everything the given
 * elements carry, plus every value already turned off by hand. The second part
 * matters in book and site view, where hiding a value can remove the only
 * element that carried it; without it the box could never be ticked again.
 */
export function profileGroups(valueSets: Iterable<ProfileValues>, hidden: Iterable<string> = []): ProfileGroup[] {
  const byAtt = new Map<string, Set<string>>();
  const put = (att: string, value: string): void => {
    let set = byAtt.get(att);
    if (!set) byAtt.set(att, (set = new Set()));
    set.add(value);
  };
  for (const values of valueSets) {
    for (const [att, list] of Object.entries(values)) for (const v of list) put(att, v);
  }
  for (const key of hidden) {
    const colon = key.indexOf(':');
    if (colon > 0) put(key.slice(0, colon), key.slice(colon + 1));
  }
  return [...byAtt.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([att, set]) => ({ att, values: [...set].sort((a, b) => a.localeCompare(b)) }));
}

/**
 * Remove from a parsed map every element the filter leaves out, with
 * everything below it: a topicref filtered out takes its sub-topics with it.
 * The element's own attributes decide. An element that merely inherits an
 * attribute cannot be left out when its parent was kept, because the parent
 * was judged on the very same values. Returns how many elements were removed.
 */
export function pruneExcluded(root: DitaNode, filter: ProfileFilter | undefined): number {
  if (isEmptyFilter(filter)) return 0;
  let removed = 0;
  const walk = (node: DitaNode): void => {
    const kept: DitaNode[] = [];
    for (const child of node.children ?? []) {
      if (child.type === 'element' && isExcluded(profileValuesOf(child.attributes), filter)) {
        removed++;
        continue;
      }
      walk(child);
      kept.push(child);
    }
    node.children = kept;
  };
  walk(root);
  return removed;
}
