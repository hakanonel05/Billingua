// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  resolveZipPath, parseChapterDoc, getTranslatableBlocks, highlightTerms, escapeXml, stripPreviousTranslation, baseBookName,
  relativeHref, updatePackageMetadata, addSpineItem, addToTableOfContents, buildGlossaryXhtml,
} from './epub';
import type { GlossaryTerm } from '../types';

const xhtml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

const term = (source: string, target: string, type: 'word' | 'idiom' = 'word'): GlossaryTerm =>
  ({ source, target, type, contextEn: '', contextTr: '' });

const isWellFormed = (xml: string) =>
  new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length === 0;

describe('resolveZipPath', () => {
  const zip = new JSZip();
  zip.file('OEBPS/Text/My Chapter.xhtml', '');
  zip.file('OEBPS/Text/raw%20name.xhtml', '');

  it('decodes percent-encoded hrefs and drops fragments', () => {
    expect(resolveZipPath(zip, 'OEBPS/', 'Text/My%20Chapter.xhtml#c1')).toBe('OEBPS/Text/My Chapter.xhtml');
  });

  it('resolves ../ segments', () => {
    expect(resolveZipPath(zip, 'OEBPS/Images/', '../Text/My%20Chapter.xhtml')).toBe('OEBPS/Text/My Chapter.xhtml');
  });

  it('falls back to the literal name when the zip stores it encoded', () => {
    expect(resolveZipPath(zip, 'OEBPS/', 'Text/raw%20name.xhtml')).toBe('OEBPS/Text/raw%20name.xhtml');
  });
});

describe('parseChapterDoc', () => {
  it('keeps well-formed XHTML as XML', () => {
    const doc = parseChapterDoc(xhtml('<p>Hi</p>'));
    expect(doc.body?.textContent).toBe('Hi');
  });

  it('falls back to the HTML parser for tag soup', () => {
    const doc = parseChapterDoc('<html><body><p>Unclosed<br><p>Second &nbsp; para</body></html>');
    expect(doc.body?.querySelectorAll('p').length).toBe(2);
  });
});

describe('getTranslatableBlocks', () => {
  it('returns outermost blocks only and skips nav', () => {
    const doc = parseChapterDoc(xhtml(
      '<nav><ol><li><a href="#a">TOC</a></li></ol></nav>' +
      '<h1>Title</h1><ul><li><p>Nested</p></li></ul><blockquote><p>Quoted</p></blockquote>'
    ));
    const blocks = getTranslatableBlocks(doc).map(el => `${el.localName}:${el.textContent}`);
    expect(blocks).toEqual(['h1:Title', 'li:Nested', 'p:Quoted']);
  });
});

describe('highlightTerms', () => {
  it('wraps matches in text nodes and never touches attributes', () => {
    const doc = parseChapterDoc(xhtml('<p id="p" class="weight">The <i>weight</i> was <a href="#weight">heavy</a>.</p>'));
    const p = doc.getElementById('p')!;
    const found = highlightTerms(p, [term('weight', 'ağırlık'), term('heavy', 'ağır')], 'source');

    expect(found.size).toBe(2);
    expect(p.getAttribute('class')).toBe('weight');
    expect(p.querySelector('a')!.getAttribute('href')).toBe('#weight');
    expect(p.querySelectorAll('span').length).toBe(2);
    expect(p.textContent).toBe('The weight was heavy.');
  });

  it('does not match inside a previous highlight span', () => {
    const doc = parseChapterDoc(xhtml('<p id="p">bold weight</p>'));
    const p = doc.getElementById('p')!;
    highlightTerms(p, [term('weight', 'x'), term('bold', 'y')], 'source');
    highlightTerms(p, [term('font', 'z')], 'source'); // "font-weight" lives only in style attributes
    expect(p.querySelectorAll('span').length).toBe(2);
    expect(isWellFormed(new XMLSerializer().serializeToString(p))).toBe(true);
  });

  it('matches Turkish suffixes on the target side', () => {
    const doc = parseChapterDoc(xhtml('<p id="p">Bütün ağırlıkları kaldırdı.</p>'));
    const p = doc.getElementById('p')!;
    highlightTerms(p, [term('weight', 'ağırlık')], 'target');
    expect(p.querySelector('span')?.textContent).toBe('ağırlıkları');
  });

  it('only highlights whole source words', () => {
    const doc = parseChapterDoc(xhtml('<p id="p">weighted weights</p>'));
    const p = doc.getElementById('p')!;
    expect(highlightTerms(p, [term('weight', 'x')], 'source').size).toBe(0);
  });
});

describe('stripPreviousTranslation', () => {
  const TD_L = 'width: 50%; padding-right: 2%; vertical-align: top; border-right: 1px solid #ccc;';
  const TD_R = 'width: 50%; padding-left: 2%; vertical-align: top;';
  const table = (left: string, right: string) =>
    `<table style="width: 100%; table-layout: fixed;"><tbody><tr><td style="${TD_L}">${left}</td><td style="${TD_R}">${right}</td></tr></tbody></table>`;
  const tr = (text: string, tag = 'p') => `<${tag} lang="tr" xml:lang="tr">${text}</${tag}>`;
  const restore = (body: string) => {
    const doc = parseChapterDoc(xhtml(body));
    const count = stripPreviousTranslation(doc);
    return { count, html: new XMLSerializer().serializeToString(doc.body!).replace(/^<body[^>]*>|<\/body>$/g, '') };
  };

  it('restores side-by-side tables, keeping the original markup', () => {
    const { count, html } = restore(
      table('<h1 id="c1">Chapter One</h1>', tr('Birinci Bölüm', 'h1')) +
      table('<p>The <i>heavy</i> <span style="font-weight: bold;">weight</span>.</p>', tr('Ağır <span style="font-weight: bold;">yük</span>.')),
    );
    expect(count).toBe(2);
    expect(html).toBe('<h1 id="c1">Chapter One</h1><p>The <i>heavy</i> weight.</p>');
  });

  it('recognizes output from versions without language tags (original on the left)', () => {
    expect(restore(table('<p>Hello.</p>', '<p>Merhaba.</p>')).html).toBe('<p>Hello.</p>');
  });

  it('restores the responsive columns and list items', () => {
    const pair = (l: string, r: string) => `<div class="bl-pair"><div class="bl-col">${l}</div><div class="bl-col">${r}</div></div>`;
    const { html } = restore(pair('<p>One.</p>', tr('Bir.')) + `<ul><li>${pair('<div><p>Item.</p></div>', tr('Öğe.', 'div'))}</li></ul>`);
    expect(html).toBe('<p>One.</p><ul><li><p>Item.</p></li></ul>');
  });

  it('removes interlinear translations', () => {
    const inter = '<p lang="tr" style="color: #495057; background-color: #f8f9fa; padding: 4px 8px; border-radius: 4px; margin-top: 4px; font-size: 0.95em; display: block;">Merhaba.</p>';
    expect(restore(`<p>Hello.</p>${inter}`).html).toBe('<p>Hello.</p>');
  });

  it('undoes a book that was translated twice', () => {
    const once = table('<p>Hello.</p>', tr('Merhaba.'));
    const twice = table(once, table(tr('Merhaba.'), tr('Selam.')));
    expect(restore(twice).html).toBe('<p>Hello.</p>');
  });

  it('leaves books that Billingua did not produce alone', () => {
    const own = '<table><tr><td>Name</td><td>Age</td></tr></table><p><span style="font-weight: bold;">Bold</span> <span lang="fr" xml:lang="fr">bonjour</span></p>';
    const { count, html } = restore(own);
    expect(count).toBe(0);
    expect(html).toContain('<span style="font-weight: bold;">Bold</span>');
    expect(html).toContain('<td>Name</td>');
  });
});

describe('baseBookName', () => {
  it('drops the suffixes of earlier runs', () => {
    expect(baseBookName('The_Sontaran_Games-Jacqueline_Rayner.epub')).toBe('The_Sontaran_Games-Jacqueline_Rayner');
    expect(baseBookName('The_Sontaran_Games-Jacqueline_Rayner_Bilingual_tr_Bilingual_tr.epub')).toBe('The_Sontaran_Games-Jacqueline_Rayner');
    expect(baseBookName('Moby_Dick_TR_TR.epub')).toBe('Moby_Dick');
    expect(baseBookName('Book_Bilingual_zh-CN.epub')).toBe('Book');
    expect(baseBookName('_TR.epub')).toBe('Book');
  });
});

describe('escapeXml and glossary', () => {
  it('escapes markup characters', () => {
    expect(escapeXml(`Tom & "Jerry" <3>`)).toBe('Tom &amp; &quot;Jerry&quot; &lt;3&gt;');
  });

  it('builds a well-formed glossary page from hostile text', () => {
    const t = { ...term('a&b', '<c>'), contextEn: 'x < y & z', contextTr: '"q"' };
    expect(isWellFormed(buildGlossaryXhtml([t], true))).toBe(true);
  });
});

describe('relativeHref', () => {
  it('walks up and encodes', () => {
    expect(relativeHref('OEBPS/Text/', 'OEBPS/glossary.html')).toBe('../glossary.html');
    expect(relativeHref('OEBPS/', 'OEBPS/glossary.html')).toBe('glossary.html');
    expect(relativeHref('', 'OEBPS/My File.html')).toBe('OEBPS/My%20File.html');
  });
});

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Moby Dick</dc:title><dc:language>en</dc:language><dc:identifier id="id">x</dc:identifier></metadata>
<manifest>
<item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="nav"/><itemref idref="c1"/></spine>
</package>`;

const NAV = xhtml('<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav>')
  .replace('<html xmlns="http://www.w3.org/1999/xhtml">', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">');

const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>t</text></docTitle>
<navMap><navPoint id="n1" playOrder="1"><navLabel><text>One</text></navLabel><content src="Text/c1.xhtml"/></navPoint></navMap></ncx>`;

describe('package document', () => {
  const parseOpf = () => new DOMParser().parseFromString(OPF, 'application/xml');
  const languages = (doc: Document) =>
    Array.from(doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')).map(l => l.textContent);
  const title = (doc: Document) => doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0].textContent;

  it('adds the target language and tags the title once', () => {
    const doc = parseOpf();
    updatePackageMetadata(doc, { sourceLang: 'auto', targetLang: 'tr', layout: 'side-by-side' });
    updatePackageMetadata(doc, { sourceLang: 'auto', targetLang: 'tr', layout: 'side-by-side' });
    expect(languages(doc)).toEqual(['en', 'tr']);
    expect(title(doc)).toBe('Moby Dick (EN–TR)');
  });

  it('switches the language for a full translation', () => {
    const doc = parseOpf();
    updatePackageMetadata(doc, { sourceLang: 'en', targetLang: 'tr', layout: 'replace' });
    expect(languages(doc)).toEqual(['tr']);
    expect(title(doc)).toBe('Moby Dick (TR)');
  });

  it('adds a spine item once', () => {
    const doc = parseOpf();
    addSpineItem(doc, 'auto-glossary', 'glossary.html');
    addSpineItem(doc, 'auto-glossary', 'glossary.html');
    const serialized = new XMLSerializer().serializeToString(doc);
    expect(serialized.match(/id="auto-glossary"/g)).toHaveLength(1);
    expect(serialized.match(/idref="auto-glossary"/g)).toHaveLength(1);
  });

  it('links the glossary from nav and NCX', async () => {
    const zip = new JSZip();
    zip.file('OEBPS/content.opf', OPF);
    zip.file('OEBPS/Text/nav.xhtml', NAV);
    zip.file('OEBPS/toc.ncx', NCX);
    const doc = parseOpf();

    await addToTableOfContents(zip, 'OEBPS/content.opf', doc, 'OEBPS/glossary.html', 'Sözlük', 'auto-glossary');
    await addToTableOfContents(zip, 'OEBPS/content.opf', doc, 'OEBPS/glossary.html', 'Sözlük', 'auto-glossary');

    const nav = await zip.file('OEBPS/Text/nav.xhtml')!.async('text');
    expect(nav.match(/href="\.\.\/glossary\.html"/g)).toHaveLength(1);
    expect(isWellFormed(nav)).toBe(true);

    const ncx = await zip.file('OEBPS/toc.ncx')!.async('text');
    expect(ncx).toContain('src="glossary.html"');
    expect(ncx).toContain('playOrder="2"');
    expect(ncx.match(/id="auto-glossary"/g)).toHaveLength(1);
  });
});
