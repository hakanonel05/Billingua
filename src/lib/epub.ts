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

// Marks the book as bilingual: adds the target language and a language tag to the title.
// For "replace" the book becomes a translation, so the target language goes first.
export const updatePackageMetadata = (
  opfDoc: Document,
  { sourceLang, targetLang, layout }: { sourceLang: string; targetLang: string; layout: string },
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
    const tag = layout === 'replace'
      ? `(${targetLang.toUpperCase()})`
      : `(${baseLang(source).toUpperCase()}–${targetLang.toUpperCase()})`;
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
