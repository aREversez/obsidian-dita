import { FileSystemAdapter, Plugin, TAbstractFile } from 'obsidian';
import { join } from 'path';
import { DitaView, VIEW_TYPE_DITA } from './DitaView';

export default class DitaViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_DITA, (leaf) => new DitaView(leaf));
    // Makes .dita files visible in the vault and opens them in the reading view.
    this.registerExtensions(['dita'], VIEW_TYPE_DITA);

    // A theme or light/dark switch changes variable values, which the preview
    // follows on its own; only the scheme flag needs a nudge.
    this.registerEvent(this.app.workspace.on('css-change', () => this.eachView((v) => v.updateScheme())));

    // Re-render when the topic, or a file it pulls content from (conref
    // targets, key maps, ...), changes on disk.
    this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultChange(file)));
  }

  private eachView(fn: (view: DitaView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DITA)) {
      if (leaf.view instanceof DitaView) fn(leaf.view);
    }
  }

  private onVaultChange(file: TAbstractFile): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = join(adapter.getBasePath(), file.path);
    this.eachView((view) => {
      if (view.dependsOnAbsolutePath(abs)) void view.refresh();
    });
  }
}
