import JSZip from 'jszip';
import type { GlossaryTerm } from '../types';

export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li";

export const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const escapeXml = (s: string) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export const safeDecode = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

// Resolves an OPF-relative href ("../Text/My%20Chapter.xhtml#x") to a zip path.
export const resolveZipPath = (zip: JSZip, baseDir: string, href: string): string => {
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part !== '.' && part !== '') out.push(part);
    }
    return out.join('/');
  };
  const withoutFragment = href.split('#')[0];
  const decoded = normalize(baseDir + safeDecode(withoutFragment));
  if (zip.file(decoded)) return decoded;
  const raw = normalize(baseDir + withoutFragment);
  return zip.file(raw) ? raw : decoded;
};

// Parses chapter content as XHTML, falling back to the HTML parser for files that are not well-formed XML.
export const parseChapterDoc = (content: string): Document => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(content, "application/xhtml+xml");
  if (xmlDoc.body && xmlDoc.getElementsByTagName("parsererror").length === 0) return xmlDoc;
  return parser.parseFromString(content, "text/html");
};

// Outermost translatable blocks only, so `li > p` is translated once and never inside the nav.
export const getTranslatableBlocks = (doc: Document): Element[] =>
  Array.from(doc.querySelectorAll(BLOCK_SELECTOR))
    .filter(el => !el.parentElement?.closest(BLOCK_SELECTOR) && !el.closest('nav'));

// Wraps glossary terms found in the text nodes of `root` in highlight spans. Works on the DOM
// (never on serialized HTML) so markup and attributes can't be matched. Returns the terms found.
export const highlightTerms = (root: Element, terms: GlossaryTerm[], field: 'source' | 'target'): Set<GlossaryTerm> => {
  const found = new Set<GlossaryTerm>();
  const usable = terms.filter(t => t[field] && t[field].length >= 3);
  if (usable.length === 0) return found;

  const doc = root.ownerDocument;
  const alternatives = usable.map(t => `(${escapeRegExp(t[field])})`).join('|');
  // Source terms match whole words; target terms may carry Turkish suffixes.
  const tail = field === 'source' ? '(?![\\p{L}\\p{N}])' : '\\p{L}*';
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})${tail}`, 'giu');

  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    const text = node.data;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(text))) {
      const term = usable[match.slice(1).findIndex(g => g !== undefined)];
      found.add(term);
      if (match.index > last) frag.appendChild(doc.createTextNode(text.slice(last, match.index)));
      const span = doc.createElementNS(XHTML_NS, 'span');
      span.setAttribute('style', term.type === 'idiom' ? 'color: #2563eb; font-weight: bold;' : 'font-weight: bold;');
      span.textContent = match[0];
      frag.appendChild(span);
      last = match.index + match[0].length;
    }
    if (last === 0) continue;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
  return found;
};

// --- Bilingual layout ---

const XML_NS = "http://www.w3.org/XML/1998/namespace";

// Styles for the "columns" layout: two columns side by side, stacked on narrow screens.
// Readers without media-query support keep the columns, readers without inline-block stack them.
export const PAIR_CSS = `
.bl-pair { margin: 0 0 1em; page-break-inside: avoid; break-inside: avoid; }
.bl-col { display: inline-block; vertical-align: top; width: 48%; box-sizing: border-box; }
.bl-col + .bl-col { margin-left: 2%; padding-left: 2%; border-left: 1px solid #ccc; }
@media (max-width: 36em) {
  .bl-col { display: block; width: auto; }
  .bl-col + .bl-col { margin: 0.25em 0 0; padding-left: 0.6em; border-left: 3px solid #ccc; }
}
`;

export const markLanguage = (el: Element, lang: string) => {
  if (!lang || lang === 'auto') return;
  el.setAttribute('lang', lang);
  el.setAttributeNS(XML_NS, 'xml:lang', lang);
};

// Creates the two-column container for one paragraph: a table for "side-by-side"
// (most compatible with old readers) or a responsive div pair for "columns".
export const createPair = (doc: Document, layout: 'side-by-side' | 'columns') => {
  if (layout === 'columns') {
    const container = doc.createElementNS(XHTML_NS, 'div');
    container.setAttribute('class', 'bl-pair');
    const left = doc.createElementNS(XHTML_NS, 'div');
    left.setAttribute('class', 'bl-col');
    const right = doc.createElementNS(XHTML_NS, 'div');
    right.setAttribute('class', 'bl-col');
    container.appendChild(left);
    container.appendChild(right);
    return { container, left, right };
  }
  const container = doc.createElementNS(XHTML_NS, 'table');
  container.setAttribute('style', 'width: 100%; border-collapse: collapse; margin-bottom: 1em; table-layout: fixed; page-break-inside: avoid; break-inside: avoid;');
  const tbody = doc.createElementNS(XHTML_NS, 'tbody');
  const tr = doc.createElementNS(XHTML_NS, 'tr');
  const left = doc.createElementNS(XHTML_NS, 'td');
  left.setAttribute('style', 'width: 50%; padding-right: 2%; vertical-align: top; border-right: 1px solid #ccc;');
  const right = doc.createElementNS(XHTML_NS, 'td');
  right.setAttribute('style', 'width: 50%; padding-left: 2%; vertical-align: top;');
  tr.appendChild(left);
  tr.appendChild(right);
  tbody.appendChild(tr);
  container.appendChild(tbody);
  return { container, left, right };
};

// --- Reading back a book Billingua already translated ---
// Recognized by the markup this app writes (also in versions before the lang attributes existed):
// the pair table's cell styles, the .bl-pair/.bl-col columns, the interlinear block style, the
// glossary highlight spans and the injected stylesheet.

const isPairCell = (el: Element | null | undefined) => {
  const style = el?.getAttribute('style') || '';
  return el?.localName === 'td' && /^width: 50%; padding-(left|right): 2%; vertical-align: top;/.test(style);
};
const pairCellsOf = (container: Element): Element[] | null => {
  if (container.localName === 'table') {
    // Own rows only; a book translated twice has pair tables nested inside the cells.
    const rows = Array.from(container.children).flatMap(c =>
      c.localName === 'tr' ? [c] : c.localName === 'tbody' ? Array.from(c.children).filter(r => r.localName === 'tr') : []);
    const cells = rows.length === 1 ? Array.from(rows[0].children) : [];
    return cells.length === 2 && cells.every(isPairCell) ? cells : null;
  }
  const classes = (container.getAttribute('class') || '').split(/\s+/);
  if (!classes.includes('bl-pair')) return null;
  const cols = Array.from(container.children).filter(c => (c.getAttribute('class') || '').split(/\s+/).includes('bl-col'));
  return cols.length === 2 ? cols : null;
};
const hasLang = (el: Element) => el.hasAttribute('lang') || el.hasAttributeNS(XML_NS, 'lang') || el.hasAttribute('xml:lang');
const INTERLINEAR_STYLE = /padding: 4px 8px; border-radius: 4px; margin-top: 4px;/;
const HIGHLIGHT_STYLES = new Set(['font-weight: bold;', 'color: #2563eb; font-weight: bold;']);

// Removes a previous Billingua translation from a chapter, restoring the original text so the book
// can be translated again instead of being doubled. Returns how many paragraphs were restored.
export const stripPreviousTranslation = (doc: Document): number => {
  const body = doc.body;
  if (!body) return 0;
  let restored = 0;

  // Side-by-side pairs: keep the original cell's content where the pair stood.
  const containers = [...Array.from(body.getElementsByTagName('table')), ...Array.from(body.getElementsByTagName('div'))]
    .filter(el => pairCellsOf(el));
  for (const container of containers) {
    const cells = pairCellsOf(container)!;
    // The translated cell holds the element marked with the target language; older versions put
    // the original on the left.
    const translatedIndex = cells.findIndex(c => Array.from(c.children).some(hasLang));
    const original = cells[translatedIndex === 0 ? 1 : 0];
    const parent = container.parentNode;
    if (!parent) continue;
    // In a list item the original was moved into a wrapper div; unwrap it again.
    const source = parent.nodeType === 1 && (parent as Element).localName === 'li' && original.children.length === 1 && original.firstElementChild?.localName === 'div'
      ? original.firstElementChild
      : original;
    while (source.firstChild) parent.insertBefore(source.firstChild, container);
    parent.removeChild(container);
    restored++;
  }

  // Interlinear translations sit right after (or inside) the original.
  for (const el of Array.from(body.querySelectorAll('[style]'))) {
    if (INTERLINEAR_STYLE.test(el.getAttribute('style') || '')) {
      el.parentNode?.removeChild(el);
      restored++;
    }
  }
  if (restored === 0) return 0;

  // Glossary highlights inside the original text.
  for (const span of Array.from(body.getElementsByTagName('span'))) {
    if (HIGHLIGHT_STYLES.has((span.getAttribute('style') || '').trim())) {
      while (span.firstChild) span.parentNode?.insertBefore(span.firstChild, span);
      span.parentNode?.removeChild(span);
    }
  }
  // The stylesheet Billingua added (fonts, columns); a new one is written on export.
  for (const style of Array.from(doc.getElementsByTagName('style'))) {
    const css = style.textContent || '';
    if (css.includes('.bl-pair') || (/font-family:[^;]*!important/.test(css) && /line-height:[^;]*!important/.test(css))) {
      style.parentNode?.removeChild(style);
    }
  }
  body.normalize();
  return restored;
};

// File name without ".epub" and without the suffixes earlier Billingua runs added
// ("Book_Bilingual_tr.epub", "Book_TR.epub"), so re-translating doesn't grow the name.
export const baseBookName = (fileName: string) =>
  fileName.replace(/\.epub$/i, '').replace(/(?:_Bilingual_[a-z]{2}(?:-[A-Za-z]{2})?|_[A-Z]{2}(?:-[A-Z]{2})?)+$/, '') || 'Book';

// Parses a chapter and drops any earlier Billingua translation from it.
export const loadChapterDoc = (content: string) => {
  const doc = parseChapterDoc(content);
  return { doc, restored: stripPreviousTranslation(doc) };
};

// --- Package (OPF) and navigation ---

const DC_NS = "http://purl.org/dc/elements/1.1/";
const EPUB_OPS_NS = "http://www.idpf.org/2007/ops";
const NCX_NS = "http://www.daisy.org/z3986/2005/ncx/";

const dirOf = (path: string) => path.substring(0, path.lastIndexOf('/') + 1);

// Relative href from a file in `fromDir` to `toPath` (both zip paths).
export const relativeHref = (fromDir: string, toPath: string): string => {
  const from = fromDir.split('/').filter(Boolean);
  const to = toPath.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].map(encodeURIComponent).join('/');
};

// Marks the book as bilingual: adds the target language and a language tag to the title
// (plus the CEFR level when the English was simplified). For "replace" the book becomes a
// translation, so the target language goes first.
export const updatePackageMetadata = (
  opfDoc: Document,
  { sourceLang, targetLang, layout, simplifyLevel = 'off' }: { sourceLang: string; targetLang: string; layout: string; simplifyLevel?: string },
) => {
  const metadata = opfDoc.getElementsByTagNameNS('*', 'metadata')[0];
  if (!metadata) return;
  const languages = Array.from(metadata.getElementsByTagNameNS(DC_NS, 'language'));
  const source = sourceLang !== 'auto' ? sourceLang : (languages[0]?.textContent?.trim() || '');
  const baseLang = (l: string) => l.trim().toLowerCase().split('-')[0];
  const hasTarget = languages.some(l => baseLang(l.textContent || '') === baseLang(targetLang));

  if (layout === 'replace') {
    if (languages[0]) {
      languages[0].textContent = targetLang;
    } else {
      const lang = opfDoc.createElementNS(DC_NS, 'dc:language');
      lang.textContent = targetLang;
      metadata.appendChild(lang);
    }
  } else if (!hasTarget) {
    const lang = opfDoc.createElementNS(DC_NS, 'dc:language');
    lang.textContent = targetLang;
    const last = languages[languages.length - 1];
    if (last) last.parentNode!.insertBefore(lang, last.nextSibling);
    else metadata.appendChild(lang);
  }

  const title = metadata.getElementsByTagNameNS(DC_NS, 'title')[0];
  if (title && source) {
    const level = simplifyLevel !== 'off' ? `, ${simplifyLevel}` : '';
    const tag = layout === 'replace'
      ? `(${targetLang.toUpperCase()}${level})`
      : `(${baseLang(source).toUpperCase()}–${targetLang.toUpperCase()}${level})`;
    const current = title.textContent?.trim() || '';
    if (!current.endsWith(tag)) title.textContent = `${current} ${tag}`.trim();
  }
};

// Adds a manifest + spine entry once.
export const addSpineItem = (opfDoc: Document, id: string, href: string) => {
  const manifest = opfDoc.getElementsByTagNameNS('*', 'manifest')[0];
  const spine = opfDoc.getElementsByTagNameNS('*', 'spine')[0];
  if (!manifest || !spine) return;
  const exists = Array.from(manifest.getElementsByTagNameNS('*', 'item')).some(i => i.getAttribute('id') === id);
  if (exists) return;
  const item = opfDoc.createElementNS(manifest.namespaceURI, 'item');
  item.setAttribute('id', id);
  item.setAttribute('href', href);
  item.setAttribute('media-type', 'application/xhtml+xml');
  manifest.appendChild(item);
  const itemref = opfDoc.createElementNS(spine.namespaceURI, 'itemref');
  itemref.setAttribute('idref', id);
  spine.appendChild(itemref);
};

// Links `targetPath` from the EPUB 3 nav document and the EPUB 2 NCX, when they exist,
// so a generated page (the glossary) shows up in the reader's table of contents.
export const addToTableOfContents = async (
  zip: JSZip,
  opfPath: string,
  opfDoc: Document,
  targetPath: string,
  label: string,
  id: string,
) => {
  const opfDir = dirOf(opfPath);
  const items = Array.from(opfDoc.getElementsByTagNameNS('*', 'item'));
  const serializer = new XMLSerializer();

  const navItem = items.find(i => (i.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  const navHref = navItem?.getAttribute('href');
  if (navHref) {
    const navPath = resolveZipPath(zip, opfDir, navHref);
    const content = await zip.file(navPath)?.async('text');
    const navDoc = content ? new DOMParser().parseFromString(content, 'application/xhtml+xml') : null;
    if (navDoc && navDoc.getElementsByTagName('parsererror').length === 0) {
      const navs = Array.from(navDoc.getElementsByTagNameNS(XHTML_NS, 'nav'));
      const isToc = (n: Element) => (n.getAttributeNS(EPUB_OPS_NS, 'type') || '').split(/\s+/).includes('toc');
      const toc = navs.find(isToc) || navs[0];
      const list = toc && Array.from(toc.children).find(c => c.localName === 'ol');
      const href = relativeHref(dirOf(navPath), targetPath);
      const linked = list && Array.from(list.getElementsByTagNameNS(XHTML_NS, 'a')).some(a => a.getAttribute('href') === href);
      if (list && !linked) {
        const li = navDoc.createElementNS(XHTML_NS, 'li');
        const a = navDoc.createElementNS(XHTML_NS, 'a');
        a.setAttribute('href', href);
        a.textContent = label;
        li.appendChild(a);
        list.appendChild(li);
        zip.file(navPath, serializer.serializeToString(navDoc));
      }
    }
  }

  const tocId = opfDoc.getElementsByTagNameNS('*', 'spine')[0]?.getAttribute('toc');
  const ncxItem = items.find(i => tocId && i.getAttribute('id') === tocId)
    || items.find(i => i.getAttribute('media-type') === 'application/x-dtbncx+xml');
  const ncxHref = ncxItem?.getAttribute('href');
  if (ncxHref) {
    const ncxPath = resolveZipPath(zip, opfDir, ncxHref);
    const content = await zip.file(ncxPath)?.async('text');
    const ncxDoc = content ? new DOMParser().parseFromString(content, 'application/xml') : null;
    const navMap = ncxDoc?.getElementsByTagNameNS('*', 'navMap')[0];
    if (ncxDoc && navMap && ncxDoc.getElementsByTagName('parsererror').length === 0) {
      const navPoints = Array.from(ncxDoc.getElementsByTagNameNS('*', 'navPoint'));
      if (!navPoints.some(p => p.getAttribute('id') === id)) {
        const ns = navMap.namespaceURI || NCX_NS;
        const playOrders = navPoints.map(p => parseInt(p.getAttribute('playOrder') || '0', 10)).filter(n => !isNaN(n));
        const navPoint = ncxDoc.createElementNS(ns, 'navPoint');
        navPoint.setAttribute('id', id);
        navPoint.setAttribute('playOrder', String(Math.max(0, ...playOrders) + 1));
        const navLabel = ncxDoc.createElementNS(ns, 'navLabel');
        const text = ncxDoc.createElementNS(ns, 'text');
        text.textContent = label;
        navLabel.appendChild(text);
        const contentEl = ncxDoc.createElementNS(ns, 'content');
        contentEl.setAttribute('src', relativeHref(dirOf(ncxPath), targetPath));
        navPoint.appendChild(navLabel);
        navPoint.appendChild(contentEl);
        navMap.appendChild(navPoint);
        zip.file(ncxPath, serializer.serializeToString(ncxDoc));
      }
    }
  }
};

// --- Glossary page ---

export const buildGlossaryXhtml = (terms: GlossaryTerm[], withContext: boolean): string => {
  const items = terms.map(term => {
    const style = term.type === 'idiom' ? ' style="color: #2563eb;"' : '';
    let li = `<li style="margin-bottom: 12px;"><strong${style}>${escapeXml(term.source)}</strong>: ${escapeXml(term.target)}`;
    if (withContext && term.contextEn) {
      li += `<br/><em style="color: #555; font-size: 0.9em;">"${escapeXml(term.contextEn)}"</em>`
        + `<br/><em style="color: #777; font-size: 0.9em;">"${escapeXml(term.contextTr)}"</em>`;
    }
    return li + '</li>';
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Glossary</title></head>
<body style="font-family: sans-serif;">
<h1>Glossary / Sözlük</h1>
<p>Important vocabulary and idioms found in this book:</p>
<ul style="line-height: 1.8;">
${items}
</ul>
</body>
</html>`;
};

// --- Sample EPUB Generator ---
export const createSampleEpub = async (): Promise<File> => {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  
  const containerXml = `<?xml version="1.0"?>
  <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
  </container>`;
  zip.file("META-INF/container.xml", containerXml);
  
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
  <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>Moby Dick (Sample)</dc:title>
      <dc:language>en</dc:language>
      <dc:identifier id="pub-id">urn:uuid:12345</dc:identifier>
    </metadata>
    <manifest>
      <item id="chapter1" href="chapter1.html" media-type="application/xhtml+xml"/>
      <item id="chapter2" href="chapter2.html" media-type="application/xhtml+xml"/>
      <item id="chapter3" href="chapter3.html" media-type="application/xhtml+xml"/>
    </manifest>
    <spine>
      <itemref idref="chapter1"/>
      <itemref idref="chapter2"/>
      <itemref idref="chapter3"/>
    </spine>
  </package>`;
  zip.file("OEBPS/content.opf", contentOpf);
  
  const ch1 = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1: Loomings</title></head><body><h1>Chapter 1: Loomings</h1><p>Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.</p><p>It is a way I have of driving off the spleen and regulating the circulation.</p></body></html>`;
  const ch2 = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 2: The Carpet-Bag</title></head><body><h1>Chapter 2: The Carpet-Bag</h1><p>I stuffed a shirt or two into my old carpet-bag, tucked it under my arm, and started for Cape Horn and the Pacific. Quitting the good city of old Manhatto, I duly arrived in New Bedford.</p><p>It was a Saturday night in December.</p></body></html>`;
  const ch3 = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 3: The Spouter-Inn</title></head><body><h1>Chapter 3: The Spouter-Inn</h1><p>Entering that gable-ended Spouter-Inn, you found yourself in a wide, low, straggling entry with old-fashioned wainscots, reminding one of the bulwarks of some condemned old craft.</p><p>On one side hung a very large oilpainting so thoroughly besmoked, and every way defaced, that in the unequal crosslights by which you viewed it, it was only by diligent study that you could any way arrive at an understanding of its purpose.</p></body></html>`;
  
  zip.file("OEBPS/chapter1.html", ch1);
  zip.file("OEBPS/chapter2.html", ch2);
  zip.file("OEBPS/chapter3.html", ch3);
  
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
  return new File([blob], "Moby_Dick_Sample.epub", { type: "application/epub+zip" });
};
