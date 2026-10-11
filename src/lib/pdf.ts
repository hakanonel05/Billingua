// Converts a finished (bilingual) EPUB into a PDF.
// The EPUB is walked in reading order and its XHTML mapped onto pdfmake content: side-by-side
// pairs become two columns, headings and paragraphs keep bold/italics/colour, PNG/JPEG images
// are embedded. pdfmake itself is loaded only when a PDF is actually requested.
import JSZip from 'jszip';
import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import { parseChapterDoc, resolveZipPath } from './epub';

export interface PdfOptions {
  title: string;
  fontSize: string;    // CSS size from the settings, e.g. "1em"
  lineSpacing: string; // CSS line-height from the settings, e.g. "1.5"
}

const BASE_FONT_SIZE = 11;
const PAGE_MARGIN = 40;
const CONTENT_WIDTH = 595.28 - 2 * PAGE_MARGIN; // A4 width in points
const MAX_IMAGE_HEIGHT = 500;

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const SKIPPED_TAGS = new Set(['script', 'style', 'svg', 'head', 'title']);
const HEADING_SIZES: Record<string, number> = { h1: 1.6, h2: 1.4, h3: 1.25, h4: 1.1, h5: 1, h6: 1 };

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};
const MAX_IMAGE_PIXELS_WIDE = 1600; // larger images are scaled down to keep the PDF small

// Decodes an image with the browser and re-encodes it as PNG/JPEG, which pdfmake always accepts.
// Corrupt images come back null and are left out instead of failing the whole PDF; formats pdfmake
// can't read (GIF, WebP, SVG) get converted. Outside a browser, PNG/JPEG are passed through as-is.
const toPdfImage = async (bytes: Uint8Array, mime: string): Promise<string | null> => {
  const canDecode = typeof createImageBitmap === 'function' && typeof Image === 'function';
  if (!canDecode) {
    if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return `data:${mime};base64,${btoa(binary)}`;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_PIXELS_WIDE / (img.naturalWidth || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 300) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 150) * scale));
    const g = canvas.getContext('2d');
    if (!g) return null;
    if (mime === 'image/jpeg') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return mime === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.88) : canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('Skipping an image the browser could not decode', err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  color?: string;
  sup?: boolean;
  sub?: boolean;
}

interface ChapterContext {
  zip: JSZip;
  dir: string; // zip directory of the chapter, for resolving image paths
  images: Map<string, string | null>; // zip path -> data URL (null: unsupported)
}

const isElement = (n: Node): n is Element => n.nodeType === 1;
const isBlock = (el: Element) => BLOCK_TAGS.has(el.localName);
// Images, including the <svg><image/></svg> cover pages Calibre writes, count as blocks.
const isPicture = (el: Element) => el.localName === 'img' || el.localName === 'svg';
const hasBlockDescendant = (el: Element): boolean =>
  Array.from(el.children).some(c => isBlock(c) || isPicture(c) || hasBlockDescendant(c));

const styleOf = (el: Element, inherited: RunStyle): RunStyle => {
  const style: RunStyle = { ...inherited };
  const tag = el.localName;
  if (tag === 'b' || tag === 'strong' || tag === 'th') style.bold = true;
  if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn') style.italics = true;
  if (tag === 'sup') style.sup = true;
  if (tag === 'sub') style.sub = true;
  const css = el.getAttribute('style') || '';
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(css)) style.bold = true;
  if (/font-style\s*:\s*italic/i.test(css)) style.italics = true;
  const color = css.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-f]{3,6})/i);
  if (color) style.color = color[1];
  return style;
};

// Text runs of an inline subtree, whitespace collapsed like a browser would.
const collectRuns = (nodes: Node[], inherited: RunStyle, runs: ContentText[]) => {
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const text = (node.nodeValue || '').replace(/\s+/g, ' ');
      if (text) runs.push({ text, ...inherited });
    } else if (isElement(node) && !SKIPPED_TAGS.has(node.localName)) {
      if (node.localName === 'br') runs.push({ text: '\n' });
      else if (node.localName !== 'img') collectRuns(Array.from(node.childNodes), styleOf(node, inherited), runs);
    }
  }
};

const trimRuns = (runs: ContentText[]) => {
  while (runs.length && !String(runs[0].text).trim()) runs.shift();
  while (runs.length && !String(runs[runs.length - 1].text).trim()) runs.pop();
  if (runs.length) {
    runs[0] = { ...runs[0], text: String(runs[0].text).replace(/^ +/, '') };
    const last = runs.length - 1;
    runs[last] = { ...runs[last], text: String(runs[last].text).replace(/ +$/, '') };
  }
  return runs;
};

const imageBlock = async (img: Element, ctx: ChapterContext): Promise<Content | null> => {
  const src = img.getAttribute('src') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
  if (!src || /^[a-z]+:/i.test(src)) return null;
  const path = resolveZipPath(ctx.zip, ctx.dir, src);
  if (!ctx.images.has(path)) {
    const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() || ''];
    const file = ctx.zip.file(path);
    ctx.images.set(path, type && file ? await toPdfImage(await file.async('uint8array'), type) : null);
  }
  const dataUrl = ctx.images.get(path);
  if (!dataUrl) return null;
  return { image: dataUrl, fit: [CONTENT_WIDTH, MAX_IMAGE_HEIGHT], alignment: 'center', margin: [0, 4, 0, 8] };
};

const paragraph = (el: Element, nodes: Node[], inherited: RunStyle): Content | null => {
  const runs = trimRuns((() => { const r: ContentText[] = []; collectRuns(nodes, inherited, r); return r; })());
  if (runs.length === 0) return null;
  const tag = el.localName;
  if (tag === 'li') runs.unshift({ text: '•  ' });
  const block: ContentText = { text: runs, margin: [0, 0, 0, 6] };
  if (HEADING_SIZES[tag]) {
    block.fontSize = BASE_FONT_SIZE * HEADING_SIZES[tag];
    block.bold = true;
    block.margin = [0, 6, 0, 8];
  }
  if (tag === 'blockquote') block.margin = [16, 0, 16, 6];
  return block;
};

// Content for the children of `el`; consecutive inline children become one paragraph.
const blocksOf = async (el: Element, ctx: ChapterContext, inherited: RunStyle): Promise<Content[]> => {
  const out: Content[] = [];
  let pendingInline: Node[] = [];
  const flush = () => {
    const p = paragraph(el, pendingInline, inherited);
    if (p) out.push(p);
    pendingInline = [];
  };

  for (const child of Array.from(el.childNodes)) {
    if (!isElement(child)) {
      pendingInline.push(child);
      continue;
    }
    if (isPicture(child)) {
      flush();
      const source = child.localName === 'svg' ? child.getElementsByTagNameNS('*', 'image')[0] : child;
      const image = source && await imageBlock(source, ctx);
      if (image) out.push(image);
    } else if (SKIPPED_TAGS.has(child.localName)) {
      continue;
    } else if (isBlock(child) || hasBlockDescendant(child)) {
      flush();
      out.push(...await blockElement(child, ctx, inherited));
    } else {
      pendingInline.push(child);
    }
  }
  flush();
  return out;
};

const columnsOf = async (cells: Element[], ctx: ChapterContext, inherited: RunStyle): Promise<Content> => ({
  columns: await Promise.all(cells.map(async cell => ({
    width: '*' as const,
    stack: await blocksOf(cell, ctx, styleOf(cell, inherited)),
  }))),
  columnGap: 14,
  margin: [0, 0, 0, 4],
});

const blockElement = async (el: Element, ctx: ChapterContext, inherited: RunStyle): Promise<Content[]> => {
  const style = styleOf(el, inherited);
  const tag = el.localName;

  // A table row, or a responsive pair (div.bl-pair > div.bl-col × 2), becomes side-by-side columns.
  if (tag === 'tr') {
    const cells = Array.from(el.children).filter(c => c.localName === 'td' || c.localName === 'th');
    return cells.length ? [await columnsOf(cells, ctx, style)] : [];
  }
  if ((el.getAttribute('class') || '').split(/\s+/).includes('bl-pair')) {
    return [await columnsOf(Array.from(el.children), ctx, style)];
  }
  if (tag === 'hr') {
    return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: '#bbbbbb' }], margin: [0, 6, 0, 10] }];
  }
  if (!hasBlockDescendant(el)) {
    const p = paragraph(el, Array.from(el.childNodes), style);
    return p ? [p] : [];
  }
  // A list item or heading that also holds blocks (e.g. li > table) keeps its children's layout.
  return blocksOf(el, ctx, style);
};

// Spine documents in reading order, without the EPUB 3 navigation document.
export const readingOrder = async (zip: JSZip): Promise<string[]> => {
  const container = await zip.file('META-INF/container.xml')?.async('text');
  if (!container) throw new Error('Invalid EPUB: Missing container.xml');
  const parser = new DOMParser();
  const opfPath = parser.parseFromString(container, 'application/xml')
    .getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  const opfContent = opfPath && await zip.file(opfPath)?.async('text');
  if (!opfPath || !opfContent) throw new Error('Invalid EPUB: Missing OPF file');

  const opf = parser.parseFromString(opfContent, 'application/xml');
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  const items = new Map(Array.from(opf.getElementsByTagNameNS('*', 'item')).map(i => [i.getAttribute('id'), i]));
  const paths: string[] = [];
  for (const ref of Array.from(opf.getElementsByTagNameNS('*', 'itemref'))) {
    const item = items.get(ref.getAttribute('idref'));
    const href = item?.getAttribute('href');
    const isNav = (item?.getAttribute('properties') || '').split(/\s+/).includes('nav');
    const type = item?.getAttribute('media-type') || '';
    if (!href || isNav || !(type.includes('html') || /\.x?html?$/i.test(href))) continue;
    paths.push(resolveZipPath(zip, opfDir, href));
  }
  return paths;
};

export const buildDocDefinition = async (zip: JSZip, options: PdfOptions): Promise<TDocumentDefinitions> => {
  const content: Content[] = [];
  const images = new Map<string, string | null>();

  for (const path of await readingOrder(zip)) {
    const source = await zip.file(path)?.async('text');
    if (!source) continue;
    const body = parseChapterDoc(source).body;
    if (!body) continue;
    const blocks = await blocksOf(body, { zip, dir: path.substring(0, path.lastIndexOf('/') + 1), images }, {});
    if (blocks.length === 0) continue;
    // Each spine document starts on a new page, like chapters in a reader.
    if (content.length > 0) content.push({ text: '', pageBreak: 'before' });
    content.push(...blocks);
  }

  const em = parseFloat(options.fontSize) || 1;
  const lineSpacing = parseFloat(options.lineSpacing) || 1.5;
  return {
    info: { title: options.title },
    pageSize: 'A4',
    pageMargins: PAGE_MARGIN,
    content,
    defaultStyle: {
      font: 'Roboto',
      fontSize: BASE_FONT_SIZE * em,
      // CSS line-height counts the whole line box; pdfmake's lineHeight is relative to the font's own spacing.
      lineHeight: Math.max(1, lineSpacing * 0.8),
    },
    footer: (current: number, total: number) => ({
      text: `${current} / ${total}`, alignment: 'center', fontSize: 8, color: '#888888', margin: [0, 10, 0, 0],
    }),
  };
};

export async function epubToPdf(epub: Blob, options: PdfOptions): Promise<Blob> {
  const zip = await JSZip.loadAsync(epub);
  const docDefinition = await buildDocDefinition(zip, options);
  const [{ default: pdfMake }, { default: vfs }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  pdfMake.addVirtualFileSystem(vfs);
  return pdfMake.createPdf(docDefinition).getBlob();
}

// Scripts Roboto (the bundled PDF font) can render.
const PDF_FONT_LANGS = new Set(['en', 'tr', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'no', 'da', 'fi', 'ro', 'hu', 'cs', 'id', 'ms', 'vi', 'ru', 'uk', 'el']);
export const pdfSupportsLanguage = (lang: string) => PDF_FONT_LANGS.has(lang.split('-')[0]);
