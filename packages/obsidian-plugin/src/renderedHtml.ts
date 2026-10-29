/**
 * Replace the children of `target` with the markup the renderer produced.
 *
 * The HTML is parsed in an inert document and its nodes moved in whole, which
 * gives the same result as assigning innerHTML. Starting at <body> keeps a
 * leading <style> or <link> from being filed under <head>.
 */
export function setRenderedHtml(target: HTMLElement, html: string): void {
  const parsed = new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, 'text/html');
  target.replaceChildren(...Array.from(parsed.body.childNodes));
}
