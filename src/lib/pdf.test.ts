// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildDocDefinition, readingOrder, pdfSupportsLanguage } from './pdf';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC';

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

const makeBook = async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="Images/p.png" media-type="image/png"/>
  </manifest><spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OEBPS/Text/nav.xhtml', xhtml('<nav><ol><li>TOC</li></ol></nav>'));
  zip.file('OEBPS/Text/c1.xhtml', xhtml(
    '<table><tbody><tr><td><h1>Chapter One</h1></td><td><h1>Birinci Bölüm</h1></td></tr></tbody></table>' +
    '<div class="bl-pair"><div class="bl-col"><p>The <i>heavy</i> <span style="font-weight: bold;">weight</span>.</p></div>' +
    '<div class="bl-col"><p lang="tr">Ağır yük.</p></div></div>'
  ));
  zip.file('OEBPS/Text/c2.xhtml', xhtml(
    '<div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../Images/p.png"/></svg></div>' +
    '<p><img src="../Images/p.png" alt=""/>Caption</p><ul><li>Item</li></ul>'
  ));
  zip.file('OEBPS/Images/p.png', PNG_1PX, { base64: true });
  return zip;
};

// Flattens pdfmake content into a list of plain strings for easy assertions.
const texts = (node: any): string[] => {
  if (node == null) return [];
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node.text !== undefined) return [texts(node.text).join('')];
  return [...texts(node.stack), ...texts(node.columns), ...texts(node.content)];
};

describe('PDF export', () => {
  it('follows the spine and skips the nav document', async () => {
    expect(await readingOrder(await makeBook())).toEqual(['OEBPS/Text/c1.xhtml', 'OEBPS/Text/c2.xhtml']);
  });

  it('turns bilingual pairs into two columns', async () => {
    const doc = await buildDocDefinition(await makeBook(), { title: 'T', fontSize: '1em', lineSpacing: '1.5' });
    const content = doc.content as any[];
    const columns = content.filter(c => c.columns);
    expect(columns).toHaveLength(2);
    expect(texts(columns[0].columns[0])).toEqual(['Chapter One']);
    expect(texts(columns[0].columns[1])).toEqual(['Birinci Bölüm']);
    expect(texts(columns[1].columns[1])).toEqual(['Ağır yük.']);
  });

  it('keeps italics and bold', async () => {
    const doc = await buildDocDefinition(await makeBook(), { title: 'T', fontSize: '1em', lineSpacing: '1.5' });
    const para = (doc.content as any[]).find(c => c.columns && texts(c).join('').includes('heavy')).columns[0].stack[0];
    const runs = para.text as any[];
    expect(runs.find(r => r.text === 'heavy')?.italics).toBe(true);
    expect(runs.find(r => r.text === 'weight')?.bold).toBe(true);
  });

  it('starts each chapter on a new page and embeds images', async () => {
    const doc = await buildDocDefinition(await makeBook(), { title: 'T', fontSize: '1.2em', lineSpacing: '1.5' });
    const content = doc.content as any[];
    expect(content.filter(c => c.pageBreak === 'before')).toHaveLength(1);
    const images = content.filter(c => c.image);
    expect(images).toHaveLength(2); // the SVG-wrapped cover and the inline image
    expect(images[0].image).toMatch(/^data:image\/png;base64,/);
    expect(texts(content)).toContain('•  Item');
    expect((doc.defaultStyle as any).fontSize).toBeCloseTo(13.2);
  });

  it('knows which languages the bundled font covers', () => {
    expect(pdfSupportsLanguage('tr')).toBe(true);
    expect(pdfSupportsLanguage('ja')).toBe(false);
  });
});
