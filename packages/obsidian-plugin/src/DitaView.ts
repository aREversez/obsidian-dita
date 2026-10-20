import { FileView, Keymap, TFile, WorkspaceLeaf, FileSystemAdapter, moment, normalizePath } from 'obsidian';
import { dirname, join } from 'path';
import coreCss from '../../dita-core/styles/dita-content.css';
import adapterCss from './theme/obsidian-adapter.css';
import { renderDitaFile } from './renderFile';

export const VIEW_TYPE_DITA = 'dita-viewer-topic';

// One pair of stylesheets per window, shared by every preview in it.
// Constructable sheets are parsed once and adopted by each shadow root; they
// cannot cross documents, so a popout window gets its own pair.
const sheetsByDocument = new WeakMap<Document, CSSStyleSheet[]>();
function getSheets(doc: Document): CSSStyleSheet[] {
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

/**
 * Read-only reading view for a .dita file.
 *
 * The rendered topic lives in a Shadow DOM. Obsidian theme selectors (which
 * target things like `table`, `code`, `a` under .markdown-rendered, or even
 * bare elements) cannot reach into it; the theme's CSS *variables* do pass
 * through, and the adapter stylesheet turns them into the preview's look.
 */
export class DitaView extends FileView {
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private body!: HTMLElement;
  private dependencies = new Set<string>();
  private rendering = false;
  private renderAgain = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DITA;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'DITA';
  }

  getIcon(): string {
    return 'file-text';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === 'dita';
  }

  async onOpen(): Promise<void> {
    const scroller = this.contentEl.createDiv({ cls: 'dita-scroller' });
    this.host = scroller.createDiv({ cls: 'dita-view' });
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = getSheets(this.host.ownerDocument);
    this.body = this.shadow.createDiv({ cls: 'dita-body' });
    this.body.id = 'dita-content-root';
    this.shadow.addEventListener('click', (evt) => this.onClick(evt as MouseEvent));
    this.updateScheme();
  }

  async onLoadFile(file: TFile): Promise<void> {
    await this.render(file);
  }

  async onUnloadFile(): Promise<void> {
    this.body?.replaceChildren();
    this.dependencies.clear();
  }

  /** Called by the plugin when a vault file changes. */
  dependsOnAbsolutePath(absPath: string): boolean {
    return this.dependencies.has(absPath);
  }

  /** Re-render after the source, or something it references, changed. */
  async refresh(): Promise<void> {
    if (this.file) await this.render(this.file);
  }

  /** The theme's light/dark flag, for the few rules that cannot be derived from variables. */
  updateScheme(): void {
    if (!this.host) return;
    const dark = this.host.ownerDocument.body.classList.contains('theme-dark');
    this.host.setAttribute('data-scheme', dark ? 'dark' : 'light');
  }

  private async render(file: TFile): Promise<void> {
    // Renders are serial: a burst of modify events collapses into one trailing render.
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.renderAgain = false;
        await this.renderOnce(file);
      } while (this.renderAgain);
    } finally {
      this.rendering = false;
    }
  }

  private async renderOnce(file: TFile): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.showMessage('DITA Viewer needs a vault stored on the local file system.');
      return;
    }
    const vaultRoot = adapter.getBasePath();
    const absPath = join(vaultRoot, file.path);
    const xml = await this.app.vault.read(file);
    const scrollTop = this.contentEl.querySelector('.dita-scroller')?.scrollTop ?? 0;

    const result = renderDitaFile({
      xml,
      absPath,
      vaultRoot,
      toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
      uiLanguage: moment.locale(),
    });
    this.dependencies = result.dependencies;

    if (result.error !== undefined) {
      this.showMessage(result.error);
      return;
    }
    this.body.innerHTML = result.html;
    this.updateScheme();
    const scroller = this.contentEl.querySelector('.dita-scroller');
    if (scroller) scroller.scrollTop = scrollTop;
  }

  private showMessage(text: string): void {
    this.body.replaceChildren();
    const p = document.createElement('p');
    p.textContent = text;
    this.body.appendChild(p);
  }

  private onClick(evt: MouseEvent): void {
    const a = (evt.target as Element | null)?.closest('a[href]');
    if (!a || !this.file) return;
    const href = a.getAttribute('href') ?? '';
    evt.preventDefault();

    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank');
      return;
    }
    if (href.startsWith('#')) {
      this.shadow.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' });
      return;
    }
    // A relative link to another file in the vault.
    const [path] = href.split('#');
    const target = this.app.vault.getAbstractFileByPath(normalizePath(join(dirname(this.file.path), decodeURIComponent(path))));
    if (target instanceof TFile) {
      void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(target);
    }
  }
}
