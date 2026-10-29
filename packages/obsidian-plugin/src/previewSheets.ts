// The stylesheets of a rendered DITA page, adopted by the shadow root of every
// preview and embed.

import coreCss from '@dita-viewer/core/styles/dita-content.css';
import adapterCss from './theme/obsidian-adapter.css';

// One pair of stylesheets per window, shared by every preview in it.
// Constructable sheets are parsed once and adopted by each shadow root; they
// cannot cross documents, so a popout window gets its own pair.
const sheetsByDocument = new WeakMap<Document, CSSStyleSheet[]>();

export function getSheets(doc: Document): CSSStyleSheet[] {
  let sheets = sheetsByDocument.get(doc);
  if (!sheets) {
    const win = doc.defaultView ?? window;
    sheets = [coreCss, adapterCss].map((css) => {
      const s = new win.CSSStyleSheet();
      s.replaceSync(css);
      return s;
    });
    sheetsByDocument.set(doc, sheets);
  }
  return sheets;
}
