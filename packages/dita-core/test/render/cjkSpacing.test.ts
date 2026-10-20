import * as assert from 'assert';
import { renderDocument, RenderContext } from '../../src/render/renderer';
import { needsSpace } from '../../src/render/cjkSpacing';
import { DitaNode } from '../../src/parser/domTypes';

const range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
const t = (text: string): DitaNode => ({ type: 'text', text, children: [], sourceRange: range });
const el = (baseType: string, children: DitaNode[], attributes?: Record<string, string>): DitaNode => ({
  type: 'element',
  tagName: baseType.replace('topic/', ''),
  baseType,
  attributes,
  children,
  sourceRange: range,
});

const keys: Record<string, string> = {
  en: 'ABC',
  enTail: '软件ABC',
  zh: '安静',
  mixed: 'ABC软件',
  path: 'C:/x',
};
const ctx: RenderContext = {
  headingLevel: 1,
  asWebviewUri: (p) => p,
  documentDir: '/test',
  resolveKey: (k) => keys[k],
};

/** Render `<p>` children and return the text with tags stripped. */
function text(children: DitaNode[], parent = 'topic/p'): string {
  const doc = el('topic/topic', [el('topic/body', [el(parent, children)])]);
  return renderDocument(doc, ctx).replace(/<[^>]+>/g, '');
}
const ph = (key: string, attrs: Record<string, string> = {}) => el('topic/ph', [], { keyref: key, ...attrs });

describe('needsSpace', () => {
  it('only fires for CJK next to Latin letters/digits', () => {
    assert.ok(needsSpace('中', 'A'));
    assert.ok(needsSpace('Z', '文'));
    assert.ok(needsSpace('中', '3'));
    assert.ok(!needsSpace('中', '，'));
    assert.ok(!needsSpace('中', ' '));
    assert.ok(!needsSpace('A', 'b'));
    assert.ok(!needsSpace('中', '文'));
    assert.ok(!needsSpace(undefined, 'A'));
  });
});

describe('keyref CJK spacing (preview)', () => {
  it('adds a space before an English-leading key', () => {
    assert.strictEqual(text([t('打开'), ph('en')]), '打开 ABC');
  });
  it('adds a space after an English-ending key', () => {
    assert.strictEqual(text([ph('enTail'), t('的菜单')]), '软件ABC 的菜单');
  });
  it('spaces both sides of an all-English key between Chinese text', () => {
    assert.strictEqual(text([t('打开'), ph('en'), t('的菜单')]), '打开 ABC 的菜单');
  });
  it('leaves an English key alone when the author already spaced it', () => {
    assert.strictEqual(text([t('Open '), ph('en'), t(' menu')]), 'Open ABC menu');
    assert.strictEqual(text([t('打开 '), ph('en'), t(' 的菜单')]), '打开 ABC 的菜单');
  });
  it('leaves Chinese keys and punctuation boundaries alone', () => {
    assert.strictEqual(text([t('打开'), ph('zh'), t('，')]), '打开安静，');
    assert.strictEqual(text([t('（'), ph('en'), t('）')]), '（ABC）');
  });
  it('judges mixed keys by their own first and last character', () => {
    assert.strictEqual(text([t('打开'), ph('mixed'), t('的菜单')]), '打开 ABC软件的菜单');
  });
  it('inserts a single space between adjacent keys', () => {
    assert.strictEqual(text([ph('enTail'), ph('zh')]), '软件ABC 安静');
    assert.strictEqual(text([ph('zh'), ph('en')]), '安静 ABC');
  });
  it('skips code-like contexts and the opt-out class', () => {
    assert.strictEqual(text([t('路径'), ph('en')], 'topic/codeph'), '路径ABC');
    assert.strictEqual(text([t('路径'), el('topic/filepath', [], { keyref: 'path' })]), '路径C:/x');
    assert.strictEqual(text([t('打开'), ph('en', { outputclass: 'no-cjk-spacing' })]), '打开ABC');
  });
  it('does not touch elements with their own content or unresolved keys', () => {
    assert.strictEqual(text([t('打开'), el('topic/ph', [t('ABC')], { keyref: 'en' })]), '打开ABC');
    assert.strictEqual(text([t('打开'), ph('missing')]), '打开[missing]');
  });
});
