// Resolve the subset of CSS the theme adapter uses -- var(), color-mix() in
// sRGB, hex / rgb() / a few names -- so tests can compute the colours a given
// Obsidian theme would produce and check contrast, without a browser.
//
// This is deliberately small. It understands exactly what obsidian-adapter.css
// writes; anything else throws rather than guessing.

export type RGB = [number, number, number];
export type Env = Readonly<Record<string, string>>;

const NAMED: Record<string, RGB> = { black: [0, 0, 0], white: [255, 255, 255] };

/** Index of the paren closing the one opened at `open`. */
function matching(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced parentheses in: ${s}`);
}

/** Split on commas that are not nested inside parentheses. */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** Replace every var(--x[, fallback]) with its value, until none are left. */
export function expandVars(expr: string, env: Env): string {
  let out = expr;
  for (let guard = 0; guard < 200; guard++) {
    const at = out.indexOf('var(');
    if (at < 0) return out.trim();
    const end = matching(out, at + 3);
    const [name, ...rest] = splitTopLevel(out.slice(at + 4, end));
    const fallback = rest.length > 0 ? rest.join(',') : undefined;
    const value = env[name] ?? fallback;
    if (value === undefined) throw new Error(`Undefined variable ${name} in: ${expr}`);
    out = out.slice(0, at) + value.trim() + out.slice(end + 1);
  }
  throw new Error(`var() expansion did not terminate: ${expr}`);
}

export function parseColor(s: string): RGB {
  const t = s.trim().toLowerCase();
  if (t in NAMED) return NAMED[t];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(t);
  if (fn) {
    const nums = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (nums.length >= 3 && nums.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [nums[0], nums[1], nums[2]];
    }
  }
  throw new Error(`Cannot parse colour: ${s}`);
}

/** Evaluate a colour expression (after var() expansion) to an sRGB triple. */
export function evalColor(expr: string, env: Env = {}): RGB {
  const e = expandVars(expr, env);
  const mix = /^color-mix\(/.exec(e);
  if (!mix) return parseColor(e);
  const args = splitTopLevel(e.slice('color-mix('.length, matching(e, 'color-mix'.length)));
  if (!/^in\s+srgb$/i.test(args[0])) throw new Error(`Only "in srgb" is supported: ${e}`);
  const side = (a: string): { c: RGB; p?: number } => {
    const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(a.trim())!;
    return { c: evalColor(m[1], env), p: m[2] === undefined ? undefined : Number(m[2]) };
  };
  const a = side(args[1]);
  const b = side(args[2]);
  const pa = a.p ?? (b.p === undefined ? 50 : 100 - b.p);
  const pb = b.p ?? 100 - pa;
  const total = pa + pb;
  return [0, 1, 2].map((i) => (a.c[i] * pa + b.c[i] * pb) / total) as RGB;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Custom-property declarations of the first `selector { ... }` block. */
export function declarationsOf(css: string, selector: string): Record<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = clean.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`No ${selector} block`);
  const open = clean.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = clean.slice(open + 1, end);
  const out: Record<string, string> = {};
  let depthP = 0;
  let start = 0;
  const flush = (to: number): void => {
    const decl = body.slice(start, to).trim();
    const colon = decl.indexOf(':');
    if (colon > 0 && decl.startsWith('--')) out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depthP++;
    else if (body[i] === ')') depthP--;
    else if (body[i] === ';' && depthP === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return out;
}
