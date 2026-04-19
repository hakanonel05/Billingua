import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import JSZip from 'jszip';
import { BookOpen, UploadCloud, Download, Loader2, CheckCircle, Layout, FileText, AlertCircle, Settings, Play, Pause, Book, Type as TypeIcon, Globe, ArrowLeft, RotateCcw, Library, Moon, Sun, Trash2, Volume2, Square, Zap, Shield, ArrowRight, Layers, X, Info, Gauge, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { saveBookToLibrary, getLibraryBooks, deleteBookFromLibrary, SavedBook } from './lib/db';
import { analyzeCEFR, getComprehensionPercentage, CEFRLevelStats } from './lib/cefr';

// --- Types & Interfaces ---
interface TranslationPayload {
  id: number;
  text: string;
}

interface TranslationResult {
  id: number;
  translation: string;
}

type LayoutType = 'side-by-side' | 'interlinear' | 'replace';
type EngineType = 'gtx' | 'gemini' | 'gtx-fallback';

interface Chapter {
  id: string;
  title: string;
  href: string;
  fullPath: string;
  selected: boolean;
  status: 'pending' | 'processing' | 'done' | 'error';
}

interface AppConfig {
  sourceLang: string;
  targetLang: string;
  layout: LayoutType;
  engine: EngineType;
  geminiModel: string;
  apiKey: string;
  buildGlossary: boolean;
  customBg: string;
  customColor: string;
  minCefrLevel: 'A1' | 'B1' | 'C1';
  extractIdioms: boolean;
  contextualGlossary: boolean;
  tone: 'default' | 'formal' | 'casual' | 'literary' | 'simple';
  customGlossary: string;
  fontFamily: string;
  fontSize: string;
  lineSpacing: string;
}

// --- Constants ---
const COMMON_WORDS = new Set(['the','be','to','of','and','a','in','that','have','i','it','for','not','on','with','he','as','you','do','at','this','but','his','by','from','they','we','say','her','she','or','an','will','my','one','all','would','there','their','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','people','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','work','first','well','way','even','new','want','because','any','these','give','day','most','us','is','are','was','were','been','being','has','had','did','doing','does']);
const IDIOMS = ['give up', 'look forward to', 'piece of cake', 'take off', 'figure out', 'carry out', 'bring up', 'catch up', 'point out', 'set up', 'turn out', 'end up', 'break down', 'find out', 'get along', 'keep on', 'make up', 'pass away', 'run out', 'show up', 'take over', 'work out', 'blessing in disguise', 'bite the bullet', 'call it a day', 'cut corners', 'get out of hand', 'hit the sack', 'miss the boat', 'under the weather', 'by the way', 'for instance', 'in terms of', 'as well as', 'sort of', 'kind of'];
const LANGUAGES = [
  { code: 'auto', name: 'Otomatik Algıla' },
  { code: 'en', name: 'İngilizce' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'es', name: 'İspanyolca' },
  { code: 'fr', name: 'Fransızca' },
  { code: 'de', name: 'Almanca' },
  { code: 'it', name: 'İtalyanca' },
  { code: 'ja', name: 'Japonca' },
  { code: 'ru', name: 'Rusça' },
  { code: 'zh-CN', name: 'Çince (Basitleştirilmiş)' },
  { code: 'zh-TW', name: 'Çince (Geleneksel)' },
  { code: 'pt', name: 'Portekizce' },
  { code: 'ar', name: 'Arapça' },
  { code: 'ko', name: 'Korece' },
  { code: 'hi', name: 'Hintçe' },
  { code: 'nl', name: 'Felemenkçe' },
  { code: 'pl', name: 'Polonyaca' },
  { code: 'sv', name: 'İsveççe' },
  { code: 'no', name: 'Norveççe' },
  { code: 'da', name: 'Danca' },
  { code: 'fi', name: 'Fince' },
  { code: 'el', name: 'Yunanca' },
  { code: 'he', name: 'İbranice' },
  { code: 'th', name: 'Tayca' },
  { code: 'vi', name: 'Vietnamca' },
  { code: 'id', name: 'Endonezyaca' },
  { code: 'ms', name: 'Malayca' },
  { code: 'ro', name: 'Romence' },
  { code: 'hu', name: 'Macarca' },
  { code: 'cs', name: 'Çekçe' },
  { code: 'uk', name: 'Ukraynaca' },
];

// --- Translation Engine ---
async function translateWithGemini(texts: TranslationPayload[], config: AppConfig): Promise<TranslationResult[]> {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const response = await ai.models.generateContent({
    model: config.geminiModel || 'gemini-3-flash-preview',
    contents: `Translate the following texts from ${config.sourceLang === 'auto' ? 'the detected language' : config.sourceLang} into ${config.targetLang}. Maintain the exact same IDs in your response.\n\n${JSON.stringify(texts)}`,
    config: {
      systemInstruction: `You are a professional book translator. Translate the given JSON array of texts. Maintain literary tone for fiction, and clear tone for non-fiction. Never change the IDs.${config.tone !== 'default' ? ` Use a ${config.tone} tone for the translation.` : ''}${config.customGlossary ? `\n\nUse the following custom glossary rules:\n${config.customGlossary}` : ''}`,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.NUMBER },
            translation: { type: Type.STRING }
          },
          required: ["id", "translation"]
        }
      }
    }
  });
  
  if (response.text) {
    let text = response.text.trim();
    if (text.startsWith('```json')) text = text.replace(/^```json\n/, '').replace(/\n```$/, '');
    if (text.startsWith('```')) text = text.replace(/^```\n/, '').replace(/\n```$/, '');
    return JSON.parse(text);
  }
  throw new Error("Empty response from Gemini");
}

async function translateBatch(texts: TranslationPayload[], config: AppConfig, pauseRef: React.MutableRefObject<boolean>): Promise<TranslationResult[]> {
  const results: TranslationResult[] = [];
  let geminiOutOfQuota = false;
  
  if (config.engine === 'gemini' && config.apiKey) {
    try {
      return await translateWithGemini(texts, config);
    } catch (err: any) {
      console.error("Gemini API Error, falling back to GTX", err);
      const errMsg = err?.message || String(err);
      if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        geminiOutOfQuota = true;
      }
      // DO NOT THROW. Fallback to GTX.
    }
  }

  // Fallback or Default: Google Translate via Proxy (batchexecute)
  // Check if we are potentially on a static host like Netlify where /api might 404
  const isStaticHost = window.location.hostname.includes('netlify.app') || 
                       window.location.hostname.includes('github.io') ||
                       window.location.hostname.includes('vercel.app');

  if (config.engine === 'gtx' && isStaticHost) {
    console.warn("Detected static host. Client-side Google Translate (GTX) might fail due to CORS. Gemini is recommended for static hosts.");
  }
  const MAX_CHARS = 2000;
  const chunks: TranslationPayload[][] = [];
  let currentChunk: TranslationPayload[] = [];
  let currentCharCount = 0;

  for (const item of texts) {
    const itemLen = item.text.length + 10; // +10 for delimiter
    if (currentCharCount + itemLen > MAX_CHARS && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [item];
      currentCharCount = itemLen;
    } else {
      currentChunk.push(item);
      currentCharCount += itemLen;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    const combinedText = chunk.map(t => t.text).join('\n\n|||\n\n');
    
    let success = false;
    let isRateLimited = false;
    let retries = 0;
    const MAX_RETRIES = 2;

    while (!success && retries <= MAX_RETRIES) {
      try {
        if (pauseRef.current) break;
        
        let response;
        try {
          response = await fetch('/api/process-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: combinedText, targetLang: config.targetLang, sourceLang: config.sourceLang })
          });
        } catch (fetchErr) {
          console.error("Proxy fetch failed, will try direct gtx", fetchErr);
        }
        
        if (response && response.ok) {
          const data = await response.json();
          const translatedCombined = data.translation || '';
          
          // Improved delimiter splitting: handle various whitespace and potential Google Translate artifacts
          const translatedParts = translatedCombined.split(/(?:\s*\|\|\|\s*)+/).filter(p => p.trim() !== '');
          
          if (translatedParts.length === chunk.length) {
            chunk.forEach((item, idx) => {
              results.push({ id: item.id, translation: translatedParts[idx].trim() || item.text });
            });
            success = true;
            await new Promise(r => setTimeout(r, 300)); // Small delay after success to avoid rate limits
          } else {
            console.warn(`Delimiter mismatch in batch translation (expected ${chunk.length}, got ${translatedParts.length}), retry ${retries}/${MAX_RETRIES}`);
          }
        } else if (!response || response.status === 404 || response.status === 502) {
          // Fallback to DIRECT Google Translate if proxy is missing (Netlify 404)
          console.log("Proxy missing or 404. Attempting direct client-side Google Translate...");
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${config.sourceLang}&tl=${config.targetLang}&dt=t&q=${encodeURIComponent(combinedText)}`;
          const directRes = await fetch(url);
          if (directRes.ok) {
            const data = await directRes.json();
            let translatedDirect = '';
            if (data && data[0]) {
              data[0].forEach((s: any) => { if (s[0]) translatedDirect += s[0]; });
            }
            
            const translatedParts = translatedDirect.split(/(?:\s*\|\|\|\s*)+/).filter(p => p.trim() !== '');
            if (translatedParts.length === chunk.length) {
              chunk.forEach((item, idx) => {
                results.push({ id: item.id, translation: translatedParts[idx].trim() || item.text });
              });
              success = true;
            }
          }
        } else {
          console.warn(`Proxy API returned ${response.status}, retry ${retries}/${MAX_RETRIES}`);
          if (response.status === 429) {
            isRateLimited = true;
            await new Promise(r => setTimeout(r, 1000 * (retries + 1))); // Exponential backoff
          }
        }
      } catch (err) {
        console.error("Batch translation error", err);
      }
      
      if (success) break;
      retries++;
      if (retries <= MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500)); // Short wait before retry
      }
    }

    if (!success) {
      if (isRateLimited) {
        console.log("Rate limited by Google Translate. Waiting before fallback...");
        await new Promise(r => setTimeout(r, 2000));
      }

      // If batch fails, and we have gtx-fallback enabled, try Gemini for the whole chunk
      if (config.engine === 'gtx-fallback' && config.apiKey && !geminiOutOfQuota) {
        try {
          console.log("Batch failed, falling back to Gemini for chunk...");
          const geminiResults = await translateWithGemini(chunk, config);
          results.push(...geminiResults);
          continue; // Skip sequential if Gemini succeeds
        } catch (geminiErr: any) {
          console.error("Gemini fallback also failed, trying sequential", geminiErr);
          const errMsg = geminiErr?.message || String(geminiErr);
          if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
            geminiOutOfQuota = true;
          }
        }
      }

      // Fallback to sequential individual requests
      for (const item of chunk) {
        let itemSuccess = false;
        let itemRetries = 0;
        const MAX_ITEM_RETRIES = 2;

        while (!itemSuccess && itemRetries <= MAX_ITEM_RETRIES) {
          try {
            const response = await fetch('/api/process-text', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: item.text, targetLang: config.targetLang, sourceLang: config.sourceLang })
            });
            if (response.ok) {
              const data = await response.json();
              results.push({ id: item.id, translation: (data.translation || '').trim() || item.text });
              itemSuccess = true;
            } else if (response.status === 429) {
               await new Promise(r => setTimeout(r, 1000 * (itemRetries + 1)));
            }
          } catch (e) {
            console.error(`Sequential error (retry ${itemRetries})`, e);
          }
          if (itemSuccess) break;
          itemRetries++;
          if (itemRetries <= MAX_ITEM_RETRIES) {
            await new Promise(r => setTimeout(r, 300));
          }
        }
        
        if (!itemSuccess) {
          // If sequential fails, and we have gtx-fallback enabled, try Gemini for this single item
          if (config.engine === 'gtx-fallback' && config.apiKey && !geminiOutOfQuota) {
            try {
              const geminiResult = await translateWithGemini([item], config);
              if (geminiResult && geminiResult.length > 0) {
                results.push(geminiResult[0]);
                itemSuccess = true;
              }
            } catch (geminiErr: any) {
              console.error("Gemini single fallback failed", geminiErr);
              const errMsg = geminiErr?.message || String(geminiErr);
              if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                geminiOutOfQuota = true;
              }
            }
          }
          
          if (!itemSuccess) {
            results.push({ id: item.id, translation: item.text }); // Ultimate fallback: original text
          }
        }
        await new Promise(r => setTimeout(r, 100)); // Minimal delay for speed
      }
    } else {
      await new Promise(r => setTimeout(r, 500)); // Increased from 200 to avoid 500 errors
    }
  }
  return results;
}

// --- Sample EPUB Generator ---
const createSampleEpub = async (): Promise<File> => {
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

// --- Main App Component ---
export default function App() {
  const [currentView, setCurrentView] = useState<'home' | 'translator' | 'library'>('home');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [libraryBooks, setLibraryBooks] = useState<SavedBook[]>([]);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [file, setFile] = useState<File | null>(null);
  const [zipInstance, setZipInstance] = useState<JSZip | null>(null);
  const [opfPath, setOpfPath] = useState<string>('');
  
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [config, setConfig] = useState<AppConfig>({
    sourceLang: 'auto',
    targetLang: 'tr',
    layout: 'side-by-side',
    engine: 'gtx',
    geminiModel: 'gemini-3-flash-preview',
    apiKey: '',
    buildGlossary: true,
    customBg: '#f8f9fa',
    customColor: '#495057',
    minCefrLevel: 'B1',
    extractIdioms: true,
    contextualGlossary: true,
    tone: 'default',
    customGlossary: '',
    fontFamily: 'sans-serif',
    fontSize: '1em',
    lineSpacing: '1.5'
  });
  
  const [progress, setProgress] = useState({ current: 0, total: 0, chapterTitle: '' });
  const [isPaused, setIsPaused] = useState(false);
  const pauseRef = useRef(false);
  
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [activePreviewId, setActivePreviewId] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState('');
  const [finalBlob, setFinalBlob] = useState<Blob | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  const [cefrStats, setCefrStats] = useState<CEFRLevelStats | null>(null);
  const [userLevel, setUserLevel] = useState<string>('B1');
  const [showTopWords, setShowTopWords] = useState(false);
  
  const [dictionaryWord, setDictionaryWord] = useState<string | null>(null);
  const [dictionaryData, setDictionaryData] = useState<any>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(false);
  const [dictionaryPos, setDictionaryPos] = useState({ x: 0, y: 0 });

  const glossaryTermsRef = useRef<{source: string, target: string, type: 'word'|'idiom', contextEn: string, contextTr: string}[]>([]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (currentView === 'library') {
      loadLibrary();
    }
  }, [currentView]);

  const loadLibrary = async () => {
    const books = await getLibraryBooks();
    setLibraryBooks(books);
  };

  const handleDeleteBook = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Bu kitabı kütüphanenizden silmek istediğinizden emin misiniz?')) {
      await deleteBookFromLibrary(id);
      loadLibrary();
    }
  };

  const handleDownloadBook = (book: SavedBook, e: React.MouseEvent) => {
    e.stopPropagation();
    const url = URL.createObjectURL(book.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = book.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setStep(1);
    setFile(null);
    setZipInstance(null);
    setOpfPath('');
    setChapters([]);
    setProgress({ current: 0, total: 0, chapterTitle: '' });
    setIsPaused(false);
    pauseRef.current = false;
    setPreviews({});
    setActivePreviewId('');
    setErrorMsg('');
    setFinalBlob(null);
    glossaryTermsRef.current = [];
  };

  const escapeRegExp = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  const highlightText = (text: string, word: string, isSource: boolean, type: 'word'|'idiom') => {
    if (!word || word.length < 3) return text;
    const style = type === 'idiom' ? 'color: #2563eb; font-weight: bold;' : 'font-weight: bold;';
    try {
      if (isSource) {
        const regex = new RegExp(`\\b(${escapeRegExp(word)})\\b`, 'gi');
        return text.replace(regex, `<span style="${style}">$1</span>`);
      } else {
        const regex = new RegExp(`(^|[^\\p{L}])(${escapeRegExp(word)}\\p{L}*)`, 'giu');
        return text.replace(regex, `$1<span style="${style}">$2</span>`);
      }
    } catch (e) {
      return text;
    }
  };

  const setSafeHTML = (el: Element, html: string, doc: Document) => {
    try {
      el.innerHTML = html;
    } catch (e) {
      // XML documents are strict about innerHTML. Fallback to manual node import.
      const parser = new DOMParser();
      const tempDoc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
      const container = tempDoc.body.firstChild;
      if (container) {
        el.innerHTML = '';
        Array.from(container.childNodes).forEach(node => {
          const imported = doc.importNode(node, true);
          el.appendChild(imported);
        });
      } else {
        el.textContent = html;
      }
    }
  };

  // --- Step 1: File Upload & Parsing ---
  const handleFile = async (uploadedFile: File) => {
    setFile(uploadedFile);
    setErrorMsg('');
    try {
      const zip = await JSZip.loadAsync(uploadedFile);
      setZipInstance(zip);
      
      const containerXml = await zip.file("META-INF/container.xml")?.async("text");
      if (!containerXml) throw new Error("Invalid EPUB: Missing container.xml");
      
      const parser = new DOMParser();
      const containerDoc = parser.parseFromString(containerXml, "application/xml");
      const rootfile = containerDoc.querySelector("rootfile");
      const opfFullPath = rootfile?.getAttribute("full-path");
      if (!opfFullPath) throw new Error("Invalid EPUB: Cannot find OPF path");
      setOpfPath(opfFullPath);
      
      const opfContent = await zip.file(opfFullPath)?.async("text");
      if (!opfContent) throw new Error("Invalid EPUB: Missing OPF file");
      
      const opfDoc = parser.parseFromString(opfContent, "application/xml");
      const manifestItems = Array.from(opfDoc.querySelectorAll("manifest > item"));
      const spineItems = Array.from(opfDoc.querySelectorAll("spine > itemref"));
      
      const basePath = opfFullPath.substring(0, opfFullPath.lastIndexOf('/') + 1);
      
      const parsedChapters: Chapter[] = [];
      const initialPreviews: Record<string, string> = {};
      const analysisTextParts: string[] = [];
      
      for (const itemref of spineItems) {
        const idref = itemref.getAttribute("idref");
        const manifestItem = manifestItems.find(item => item.getAttribute("id") === idref);
        if (manifestItem) {
          const href = manifestItem.getAttribute("href");
          if (href && (href.endsWith('.html') || href.endsWith('.xhtml') || href.endsWith('.htm'))) {
            const fullPath = basePath + href;
            
            // Try to extract title from HTML
            let title = `Chapter (${idref})`;
            try {
              const htmlContent = await zip.file(fullPath)?.async("text");
              if (htmlContent) {
                const htmlDoc = parser.parseFromString(htmlContent, "text/html");
                
                // Store initial preview content
                initialPreviews[idref || fullPath] = htmlDoc.body.innerHTML;
                
                // Collect clean text for analysis
                analysisTextParts.push(htmlDoc.body.textContent || "");

                let extractedTitle = "";
                const titleTag = htmlDoc.querySelector("title");
                const titleText = titleTag?.textContent?.trim() || "";
                
                // Ignore generic/useless title tags
                if (titleText && !['unnamed', 'unknown', 'chapter', 'blank', 'title page', 'cover'].includes(titleText.toLowerCase())) {
                  extractedTitle = titleText;
                }
                
                if (!extractedTitle) {
                  const headings = Array.from(htmlDoc.querySelectorAll("h1, h2, h3"));
                  if (headings.length > 0) {
                    // Combine first few headings if they are short, or just use the first one
                    extractedTitle = headings.map(h => h.textContent?.trim()).filter(Boolean).slice(0, 2).join(" - ");
                  }
                }
                
                if (!extractedTitle) {
                  // Look for elements with class containing 'title' or 'chapter'
                  const titleElements = Array.from(htmlDoc.querySelectorAll("[class*='title'], [class*='chapter']"));
                  const validTitleElements = titleElements.filter(el => {
                    const text = el.textContent?.trim() || "";
                    // Exclude elements that contain too much text (likely not just a title)
                    return text.length > 0 && text.length < 100;
                  });
                  if (validTitleElements.length > 0) {
                    extractedTitle = validTitleElements.slice(0, 2).map(el => el.textContent?.trim()).join(" - ");
                  }
                }
                
                if (!extractedTitle) {
                  // Just find the first non-empty text element that looks like a title
                  const textElements = Array.from(htmlDoc.querySelectorAll("p, div, span")).filter(el => {
                    const text = el.textContent?.trim() || '';
                    return text.length > 0 && text.length < 100;
                  });
                  if (textElements.length > 0) {
                    extractedTitle = textElements[0].textContent!.trim();
                  }
                }
                
                if (extractedTitle) {
                  // Clean up the title (remove excessive whitespace/newlines)
                  title = extractedTitle.replace(/\s+/g, ' ').substring(0, 60);
                  if (extractedTitle.length > 60) title += '...';
                }
              }
            } catch (e) {}
            
            parsedChapters.push({
              id: idref || Math.random().toString(),
              title,
              href,
              fullPath,
              selected: true,
              status: 'pending'
            });
          }
        }
      }
      
      setChapters(parsedChapters);
      setPreviews(initialPreviews);
      
      // Perform CEFR analysis on clean text
      const fullTextSample = analysisTextParts.join(' ').substring(0, 200000);
      const stats = analyzeCEFR(fullTextSample);
      setCefrStats(stats);
      
      if (parsedChapters.length > 0) {
        setActivePreviewId(parsedChapters[0].id);
      }
      setStep(2);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to parse EPUB file.");
      setFile(null);
    }
  };

  const handleTrySample = async () => {
    try {
      const sampleFile = await createSampleEpub();
      await handleFile(sampleFile);
    } catch (err) {
      setErrorMsg("Failed to create sample EPUB.");
    }
  };

  // --- Step 3: Processing ---
  const processBook = async () => {
    if (!zipInstance) return;
    setStep(3);
    setIsPaused(false);
    pauseRef.current = false;
    setErrorMsg('');
    
    const selectedChapters = chapters.filter(c => c.selected);
    setProgress(p => ({ ...p, total: selectedChapters.length }));
    
    const parser = new DOMParser();
    const serializer = new XMLSerializer();
    const translationMemory = new Map<string, string>();

    // Phase 1: Build Glossary before translating chapters
    glossaryTermsRef.current = [];
    if (config.buildGlossary) {
      setProgress(p => ({ ...p, current: 0, chapterTitle: 'Analyzing text for glossary...' }));
      const counts = new Map<string, { count: number, type: 'word'|'idiom' }>();
      
      for (const chapter of selectedChapters) {
        try {
          const content = await zipInstance.file(chapter.fullPath)?.async("text");
          if (content) {
            const htmlDoc = parser.parseFromString(content, "application/xhtml+xml");
            const text = htmlDoc.body.textContent || '';
            
            // Extract words
            const words = text.match(/\b[a-zA-Z]{4,}\b/g);
            if (words) {
              words.forEach(w => {
                const lower = w.toLowerCase();
                let isValid = false;
                if (config.minCefrLevel === 'A1') isValid = true;
                else if (config.minCefrLevel === 'B1') isValid = !COMMON_WORDS.has(lower) && lower.length >= 5;
                else if (config.minCefrLevel === 'C1') isValid = !COMMON_WORDS.has(lower) && lower.length >= 7;
                
                if (isValid) {
                  const current = counts.get(lower) || { count: 0, type: 'word' };
                  counts.set(lower, { count: current.count + 1, type: 'word' });
                }
              });
            }

            // Extract idioms
            if (config.extractIdioms) {
              const lowerText = text.toLowerCase();
              IDIOMS.forEach(idiom => {
                const regex = new RegExp(`\\b${idiom}\\b`, 'g');
                const matches = lowerText.match(regex);
                if (matches) {
                  const current = counts.get(idiom) || { count: 0, type: 'idiom' };
                  counts.set(idiom, { count: current.count + matches.length, type: 'idiom' });
                }
              });
            }
          }
        } catch (e) {
          console.error(`Failed to analyze chapter ${chapter.title} for glossary`, e);
        }
      }

      const topItems = Array.from(counts.entries())
        .sort((a, b) => {
          if (a[1].type === 'idiom' && b[1].type === 'word') return -1;
          if (a[1].type === 'word' && b[1].type === 'idiom') return 1;
          return b[1].count - a[1].count;
        })
        .slice(0, 50);

      if (topItems.length > 0) {
        setProgress(p => ({ ...p, chapterTitle: 'Translating glossary terms...' }));
        const payload = topItems.map((item, i) => ({ id: i, text: item[0] }));
        try {
          const translations = await translateBatch(payload, config, pauseRef);
          const terms = topItems.map((item, i) => {
            const trans = translations.find(t => t.id === i)?.translation || '';
            return { 
              source: item[0], 
              target: trans.toLowerCase().trim(), 
              type: item[1].type,
              contextEn: '',
              contextTr: ''
            };
          });
          glossaryTermsRef.current = terms.sort((a, b) => b.source.length - a.source.length);
        } catch (err) {
          console.error("Glossary translation failed", err);
        }
      }
    }
    
    let processedCount = chapters.filter(c => c.status === 'done').length;

    for (let i = 0; i < chapters.length; i++) {
      if (pauseRef.current) break;
      const chapter = chapters[i];
      if (!chapter.selected || chapter.status === 'done') continue;
      
      setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, status: 'processing' } : c));
      setProgress(p => ({ ...p, current: processedCount + 1, chapterTitle: chapter.title }));
      
      try {
        const content = await zipInstance.file(chapter.fullPath)?.async("text");
        if (!content) throw new Error("File content not found");
        
        const htmlDoc = parser.parseFromString(content, "application/xhtml+xml");
        const elements = Array.from(htmlDoc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li"));
        
        if (elements.length > 0) {
          const BATCH_SIZE = 10; // Reduced from 15 to avoid 500 errors
          for (let j = 0; j < elements.length; j += BATCH_SIZE) {
            if (pauseRef.current) break;
            const batch = elements.slice(j, j + BATCH_SIZE);
            const payload: any[] = [];
            const cached: any[] = [];
            
            batch.forEach((el, idx) => {
              const text = el.textContent!.trim();
              if (text.length > 0) {
                if (translationMemory.has(text)) {
                  cached.push({ id: idx, translation: translationMemory.get(text)! });
                } else {
                  payload.push({ id: idx, text });
                }
              }
            });
            
            let translations = [...cached];
            if (payload.length > 0) {
              const apiTranslations = await translateBatch(payload, config, pauseRef);
              apiTranslations.forEach(t => {
                const originalText = payload.find(p => p.id === t.id)?.text;
                if (originalText) translationMemory.set(originalText, t.translation);
              });
              translations = [...translations, ...apiTranslations];
            }
              
            batch.forEach((el, idx) => {
              const transObj = translations.find(t => t.id === idx);
                if (transObj && transObj.translation && transObj.translation !== payload.find(p => p.id === idx)?.text) {
                  
                  let sourceText = el.textContent || '';
                  let targetText = transObj.translation;

                  if (config.buildGlossary && glossaryTermsRef.current.length > 0) {
                    glossaryTermsRef.current.forEach(term => {
                      const sourceHasTerm = new RegExp(`\\b${escapeRegExp(term.source)}\\b`, 'i').test(sourceText);
                      if (sourceHasTerm) {
                        sourceText = highlightText(sourceText, term.source, true, term.type);
                        targetText = highlightText(targetText, term.target, false, term.type);
                        
                        if (config.contextualGlossary && !term.contextEn) {
                          term.contextEn = el.textContent || '';
                          term.contextTr = transObj.translation;
                        }
                      }
                    });
                  }

                  if (config.layout === 'side-by-side') {
                    const table = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "table");
                    table.setAttribute("style", "width: 100%; border-collapse: collapse; margin-bottom: 1em; table-layout: fixed;");
                    const tbody = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "tbody");
                    const tr = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "tr");
                    
                    const tdLeft = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "td");
                    tdLeft.setAttribute("style", "width: 50%; padding-right: 2%; vertical-align: top; border-right: 1px solid #ccc;");
                    
                    const tdRight = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "td");
                    tdRight.setAttribute("style", "width: 50%; padding-left: 2%; vertical-align: top;");
                    
                    const translatedEl = el.cloneNode(false) as Element;
                    setSafeHTML(translatedEl, targetText, htmlDoc);
                    setSafeHTML(el, sourceText, htmlDoc);
                    
                    // Logic to ensure English is always on the left and Turkish on the right
                    const shouldSwap = (config.targetLang === 'en' && config.sourceLang !== 'en') || 
                                     (config.sourceLang === 'tr' && config.targetLang !== 'tr');

                    el.parentNode?.insertBefore(table, el);
                    
                    if (shouldSwap) {
                      tdLeft.appendChild(translatedEl);
                      tdRight.appendChild(el);
                    } else {
                      tdLeft.appendChild(el);
                      tdRight.appendChild(translatedEl);
                    }

                    tr.appendChild(tdLeft);
                    tr.appendChild(tdRight);
                    tbody.appendChild(tr);
                    table.appendChild(tbody);
                  } 
                  else if (config.layout === 'interlinear') {
                    const transEl = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", el.tagName.toLowerCase());
                    transEl.setAttribute("style", `color: ${config.customColor}; background-color: ${config.customBg}; padding: 4px 8px; border-radius: 4px; margin-top: 4px; font-size: 0.95em; display: block;`);
                    setSafeHTML(transEl, targetText, htmlDoc);
                    setSafeHTML(el, sourceText, htmlDoc);
                    el.parentNode?.insertBefore(transEl, el.nextSibling);
                  }
                  else if (config.layout === 'replace') {
                    setSafeHTML(el, targetText, htmlDoc);
                  }
                }
              });
              
              // --- LIVE PREVIEW UPDATE ---
              if (!pauseRef.current) {
                // For preview, we only want the body content to avoid <html>/<body> tags inside our preview div
                const previewHtml = htmlDoc.body.innerHTML;
                setPreviews(prev => {
                  const newPreviews = { ...prev, [chapter.id]: previewHtml };
                  return newPreviews;
                });
                // Switch to the currently translating chapter if no preview is active
                setActivePreviewId(prevId => prevId || chapter.id);
              }
            }
          }
        
        if (!pauseRef.current) {
          const styleEl = htmlDoc.createElementNS("http://www.w3.org/1999/xhtml", "style");
          styleEl.textContent = `
            body {
              font-family: ${config.fontFamily} !important;
              font-size: ${config.fontSize} !important;
              line-height: ${config.lineSpacing} !important;
            }
          `;
          htmlDoc.head?.appendChild(styleEl);

          const finalHtml = serializer.serializeToString(htmlDoc);
          zipInstance.file(chapter.fullPath, finalHtml);
          
          // Final preview update for this chapter
          const finalPreviewHtml = htmlDoc.body.innerHTML;
          setPreviews(prev => {
            const newPreviews = { ...prev, [chapter.id]: finalPreviewHtml };
            return newPreviews;
          });
          setActivePreviewId(prevId => prevId || chapter.id);
          setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, status: 'done' } : c));
          processedCount++;
        }
      } catch (err) {
        console.error(`Failed to process chapter ${chapter.title}`, err);
        setChapters(prev => prev.map(c => c.id === chapter.id ? { ...c, status: 'error' } : c));
      }
    }
    
    if (!pauseRef.current) {
      await finalizeBook();
    }
  };

  const finalizeBook = async () => {
    if (!zipInstance) return;
    
    // Build Glossary if enabled
    if (config.buildGlossary && glossaryTermsRef.current.length > 0) {
      setProgress(p => ({ ...p, chapterTitle: 'Finalizing Glossary...' }));
      
      let glossaryHtml = `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>Glossary</title></head>
      <body style="font-family: sans-serif;">
        <h1>Glossary / Sözlük</h1>
        <p>Important vocabulary and idioms found in this book:</p>
        <ul style="line-height: 1.8;">`;
        
      glossaryTermsRef.current.forEach(term => {
        const style = term.type === 'idiom' ? 'color: #2563eb;' : '';
        glossaryHtml += `<li style="margin-bottom: 12px;">
          <strong style="${style}">${term.source}</strong>: ${term.target}`;
          
        if (config.contextualGlossary && term.contextEn) {
          glossaryHtml += `<br/>
          <em style="color: #555; font-size: 0.9em;">"${term.contextEn}"</em><br/>
          <em style="color: #777; font-size: 0.9em;">"${term.contextTr}"</em>`;
        }
        
        glossaryHtml += `</li>`;
      });
      glossaryHtml += `</ul></body></html>`;
      
      const basePath = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
      zipInstance.file(`${basePath}glossary.html`, glossaryHtml);
      
      // Update OPF
      try {
        const opfContent = await zipInstance.file(opfPath)?.async("text");
        if (opfContent) {
          const parser = new DOMParser();
          const serializer = new XMLSerializer();
          const opfDoc = parser.parseFromString(opfContent, "application/xml");
          
          const manifest = opfDoc.querySelector("manifest");
          const spine = opfDoc.querySelector("spine");
          
          if (manifest && spine) {
            const item = opfDoc.createElementNS(manifest.namespaceURI, "item");
            item.setAttribute("id", "auto-glossary");
            item.setAttribute("href", "glossary.html");
            item.setAttribute("media-type", "application/xhtml+xml");
            manifest.appendChild(item);
            
            const itemref = opfDoc.createElementNS(spine.namespaceURI, "itemref");
            itemref.setAttribute("idref", "auto-glossary");
            spine.appendChild(itemref);
            
            zipInstance.file(opfPath, serializer.serializeToString(opfDoc));
          }
        }
      } catch (e) {
        console.error("Failed to update OPF with glossary", e);
      }
      
      setPreviews(prev => ({ ...prev, 'auto-glossary': glossaryHtml }));
    }
    
    const blob = await zipInstance.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
    setFinalBlob(blob);
    
    // Save to library
    const bookTitle = file?.name.replace('.epub', '') || 'Translated_Book';
    const savedBook: SavedBook = {
      id: Date.now().toString(),
      title: `${bookTitle}_${config.targetLang.toUpperCase()}.epub`,
      date: Date.now(),
      blob: blob,
      sourceLang: config.sourceLang,
      targetLang: config.targetLang
    };
    await saveBookToLibrary(savedBook);

    setStep(4);
  };

  const handlePause = () => {
    pauseRef.current = true;
    setIsPaused(true);
  };

  const handleResume = () => {
    pauseRef.current = false;
    setIsPaused(false);
    processBook();
  };

  const handleCancelTranslation = () => {
    if (confirm('Çeviriyi iptal etmek istediğinizden emin misiniz? (Mevcut bölüm çevirisi durdurulacak)')) {
      pauseRef.current = true;
      setStep(2);
      // Reset statuses of processing chapters back to pending
      setChapters(prev => prev.map(ch => 
        ch.status === 'processing' ? { ...ch, status: 'pending' } : ch
      ));
    }
  };

  const downloadEpub = () => {
    if (!finalBlob || !file) return;
    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name.replace('.epub', `_Bilingual_${config.targetLang}.epub`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleTTS = () => {
    if (!activePreviewId || !previews[activePreviewId]) return;
    
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }

    const doc = new DOMParser().parseFromString(previews[activePreviewId], 'text/html');
    const text = doc.body.textContent || '';
    
    if (!text.trim()) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = config.targetLang;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    setIsSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  // Stop TTS when unmounting or changing preview
  useEffect(() => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, [activePreviewId]);

  // Close dictionary popup on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dictionaryWord && !(e.target as Element).closest('.dictionary-popup')) {
        setDictionaryWord(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dictionaryWord]);

  const handleTextSelection = async () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setDictionaryWord(null);
      return;
    }

    const text = selection.toString().trim();
    if (!text || text.includes(' ') || text.length < 2) {
      setDictionaryWord(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    setDictionaryPos({
      x: rect.left + rect.width / 2,
      y: rect.bottom + window.scrollY
    });
    
    setDictionaryWord(text);
    setDictionaryLoading(true);
    
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${text}`);
      if (res.ok) {
        const data = await res.json();
        setDictionaryData(data[0]);
      } else {
        setDictionaryData(null);
      }
    } catch (error) {
      setDictionaryData(null);
    } finally {
      setDictionaryLoading(false);
    }
  };

  // --- Render Helpers ---
  return (
    <div className={`min-h-screen transition-colors duration-300 ${isDarkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'} font-sans selection:bg-blue-200`}>
      {/* Top Banner (like the screenshot) */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-center py-2 px-4 text-sm font-medium flex items-center justify-center gap-2">
        <span className="bg-white/20 px-2 py-0.5 rounded text-xs font-bold">YENİ</span>
        <span>Canlı Önizleme özelliği artık aktif! Çevirileri gerçek zamanlı olarak görün.</span>
      </div>

      <header className={`${isDarkMode ? 'bg-slate-950/80 border-slate-800' : 'bg-white/80 border-slate-200'} backdrop-blur-md border-b sticky top-0 z-50 transition-colors duration-300`}>
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setCurrentView('home')}>
            <div className="bg-gradient-to-br from-blue-500 to-cyan-500 p-2 rounded-xl shadow-md">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <h1 className={`text-xl font-bold tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Epub Master</h1>
          </div>
          
          <nav className="hidden md:flex items-center gap-8 font-medium text-sm">
            <button onClick={() => setCurrentView('home')} className={`transition-colors ${currentView === 'home' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}>Ana Sayfa</button>
            <button onClick={() => setCurrentView('translator')} className={`transition-colors ${currentView === 'translator' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}>Çeviri Yap</button>
            <button onClick={() => setCurrentView('library')} className={`transition-colors ${currentView === 'library' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}>Kütüphanem</button>
          </nav>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => setCurrentView('library')}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium transition-colors ${currentView === 'library' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
            >
              <Library className="w-5 h-5" />
              <span className="hidden sm:inline">Kütüphanem</span>
            </button>
            <button 
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition-colors"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {currentView === 'home' && (
          <div className="animate-fade-in pb-20">
            {/* Hero Section */}
            <div className="relative pt-16 pb-24 text-center px-4 overflow-hidden">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-tr from-cyan-400/20 to-blue-500/20 rounded-full blur-3xl -z-10"></div>
              
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 font-medium text-sm mb-8 border border-blue-100 dark:border-blue-800/50">
                <span className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400 animate-pulse"></span>
                Yeni: Canlı Önizleme Özelliği Eklendi
              </div>
              
              <h1 className={`text-5xl md:text-7xl font-extrabold tracking-tight mb-6 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                EPUB Dosyalarını <br className="hidden md:block" />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-500 to-blue-600">Hızlı ve Kolay Çevirin</span>
              </h1>
              
              <p className={`text-xl mb-10 max-w-2xl mx-auto ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>
                Profesyonel EPUB çevirisi. Gelişmiş yapay zeka kullanarak 30'dan fazla dilde kitaplarınızın formatını, stilini ve içeriğini koruyun.
              </p>
              
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
                <button 
                  onClick={() => setCurrentView('translator')} 
                  className="flex items-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 text-white px-8 py-4 rounded-full font-bold text-lg hover:shadow-lg hover:shadow-blue-500/30 transition-all hover:-translate-y-0.5 w-full sm:w-auto justify-center"
                >
                  Hemen Çevir <ArrowRight className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => { document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' }) }} 
                  className={`flex items-center gap-2 px-8 py-4 rounded-full font-bold text-lg border transition-all w-full sm:w-auto justify-center ${isDarkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
                >
                  Özellikleri İncele
                </button>
              </div>
              
              <div className="flex flex-wrap justify-center gap-4 md:gap-8">
                {[
                  { icon: <UploadCloud className="w-5 h-5" />, text: "Kolay Yükleme" },
                  { icon: <Globe className="w-5 h-5" />, text: "30+ Dil Desteği" },
                  { icon: <Shield className="w-5 h-5" />, text: "Güvenli ve Gizli" },
                  { icon: <Zap className="w-5 h-5" />, text: "Hızlı İşleme" }
                ].map((feature, i) => (
                  <div key={i} className={`flex items-center gap-2 px-4 py-2 rounded-full border ${isDarkMode ? 'bg-slate-800/50 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-600'} shadow-sm`}>
                    {feature.icon}
                    <span className="font-medium text-sm">{feature.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* How it Works Section */}
            <div id="how-it-works" className="max-w-5xl mx-auto px-6 py-20">
              <h2 className={`text-3xl font-bold text-center mb-16 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Epub Master Nasıl Kullanılır?</h2>
              <div className="grid md:grid-cols-3 gap-8">
                {[
                  {
                    step: "01",
                    title: "EPUB Dosyasını Yükleyin",
                    desc: "EPUB dosyanızı sürükleyip bırakın. Dosyanızın formatını bozmadan bölümleri ve yapıyı güvenle analiz ederiz.",
                    icon: <UploadCloud className="w-8 h-8 text-blue-500" />
                  },
                  {
                    step: "02",
                    title: "Ayarları Yapılandırın",
                    desc: "Hedef dili seçin, bir çeviri motoru (Gemini veya Google) belirleyin ve tercih ettiğiniz okuma düzenini seçin.",
                    icon: <Settings className="w-8 h-8 text-cyan-500" />
                  },
                  {
                    step: "03",
                    title: "Çevir ve Oku",
                    desc: "Çeviri sürecini canlı önizleme ile gerçek zamanlı izleyin. İşlem tamamlandığında iki dilli dosyanızı indirin.",
                    icon: <BookOpen className="w-8 h-8 text-blue-500" />
                  }
                ].map((item, i) => (
                  <div key={i} className={`p-8 rounded-3xl border relative overflow-hidden ${isDarkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-white border-slate-100 shadow-xl shadow-slate-200/20'}`}>
                    <div className={`text-6xl font-black absolute -top-4 -right-4 opacity-10 ${isDarkMode ? 'text-slate-500' : 'text-slate-300'}`}>{item.step}</div>
                    <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 ${isDarkMode ? 'bg-slate-800' : 'bg-blue-50'}`}>
                      {item.icon}
                    </div>
                    <h3 className={`text-xl font-bold mb-3 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{item.title}</h3>
                    <p className={`leading-relaxed ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {currentView === 'library' && (
          <div className="animate-fade-in">
            <div className="flex items-center justify-between mb-8">
              <h2 className={`text-3xl font-bold ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>Kütüphanem</h2>
              <button 
                onClick={() => setCurrentView('translator')}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                <UploadCloud className="w-4 h-4" /> Yeni Kitap Çevir
              </button>
            </div>
            
            {libraryBooks.length === 0 ? (
              <div className={`text-center py-20 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'} rounded-3xl border border-dashed`}>
                <Library className={`w-16 h-16 mx-auto mb-4 ${isDarkMode ? 'text-slate-600' : 'text-slate-400'}`} />
                <h3 className={`text-xl font-bold mb-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Kütüphaneniz henüz boş</h3>
                <p className={`mb-6 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Çevrilen kitaplar otomatik olarak burada görünecektir.</p>
                <button 
                  onClick={() => setCurrentView('translator')}
                  className="bg-blue-600 text-white px-6 py-3 rounded-xl hover:bg-blue-700 transition-colors font-bold"
                >
                  Çeviriye Başla
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {libraryBooks.map(book => (
                  <div key={book.id} className={`group relative ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'} rounded-2xl p-6 border shadow-sm hover:shadow-md transition-all`}>
                    <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={(e) => handleDeleteBook(book.id, e)}
                        className={`p-2 rounded-lg transition-colors ${isDarkMode ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50' : 'bg-red-100 text-red-600 hover:bg-red-200'}`}
                        title="Delete from library"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className={`w-16 h-16 rounded-xl flex items-center justify-center mb-4 ${isDarkMode ? 'bg-blue-900/50 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>
                      <Book className="w-8 h-8" />
                    </div>
                    <h3 className={`font-bold text-lg mb-1 truncate ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`} title={book.title}>{book.title}</h3>
                    <p className={`text-sm mb-4 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                      {new Date(book.date).toLocaleDateString()} • {book.sourceLang.toUpperCase()} → {book.targetLang.toUpperCase()}
                    </p>
                    <button 
                      onClick={(e) => handleDownloadBook(book, e)}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${isDarkMode ? 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
                    >
                      <Download className="w-4 h-4" /> İndir
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {currentView === 'translator' && (
          <div className="animate-fade-in">
            {errorMsg && (
          <div className={`mb-6 border px-4 py-3 rounded-xl flex items-center gap-3 animate-fade-in ${isDarkMode ? 'bg-red-900/30 border-red-800 text-red-400' : 'bg-red-50 border-red-200 text-red-700'}`}>
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{errorMsg}</p>
          </div>
        )}

        {/* STEP 1: UPLOAD */}
        {step === 1 && (
          <div className="max-w-3xl mx-auto mt-12 flex flex-col items-center gap-8 animate-slide-up">
            <div className="text-center space-y-3">
              <h2 className={`text-4xl font-extrabold tracking-tight ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>Çeviriye Başla</h2>
              <p className={`text-lg ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Süreci başlatmak için EPUB dosyanızı yükleyin.</p>
            </div>

            <div 
              onDragOver={(e) => e.preventDefault()} 
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              className={`w-full border-2 border-dashed rounded-[2rem] p-16 flex flex-col items-center justify-center text-center transition-all cursor-pointer shadow-sm group ${isDarkMode ? 'border-blue-500/30 bg-blue-900/10 hover:bg-blue-900/20 hover:border-blue-500/50' : 'border-blue-200 bg-blue-50/30 hover:bg-blue-50/80 hover:border-blue-400'}`}
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <div className={`p-6 rounded-2xl shadow-sm mb-6 group-hover:scale-110 group-hover:-translate-y-2 transition-all duration-300 ${isDarkMode ? 'bg-slate-800 text-blue-400' : 'bg-white text-blue-600'}`}>
                <UploadCloud className="w-12 h-12" />
              </div>
              <h3 className={`text-2xl font-bold mb-3 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Dosyayı buraya sürükleyin veya tıklayın</h3>
              <p className={`mb-8 max-w-sm text-sm ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Sadece EPUB dosyaları desteklenir. Dosyanız güvenle işlenir.</p>
              <button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-8 py-4 rounded-full font-bold transition-all shadow-md hover:shadow-lg">
                EPUB Dosyası Seç
              </button>
              <input id="file-upload" type="file" accept=".epub" className="hidden" onChange={(e) => e.target.files && handleFile(e.target.files[0])} />
            </div>
            
            <div className={`flex items-center gap-4 w-full max-w-md opacity-60`}>
              <div className={`h-px flex-1 ${isDarkMode ? 'bg-slate-700' : 'bg-slate-300'}`}></div>
              <span className={`font-semibold text-xs uppercase tracking-widest ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>VEYA ÖRNEK DENEYİN</span>
              <div className={`h-px flex-1 ${isDarkMode ? 'bg-slate-700' : 'bg-slate-300'}`}></div>
            </div>
            
            <button 
              onClick={handleTrySample}
              className={`flex items-center gap-2 px-6 py-3 rounded-full font-medium transition-all ${isDarkMode ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700' : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200 shadow-sm'}`}
            >
              <BookOpen className="w-5 h-5 text-blue-500" />
              Moby Dick Örneğini Kullan
            </button>
          </div>
        )}

        {/* STEP 2: CONFIGURATION */}
        {step === 2 && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 animate-slide-up">
            <div className="lg:col-span-8 space-y-6">
              <div className={`p-8 rounded-3xl shadow-sm border ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className={`flex items-center justify-between mb-6 pb-4 border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${isDarkMode ? 'bg-blue-900/50' : 'bg-blue-100'}`}>
                      <Settings className={`w-5 h-5 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}/>
                    </div>
                    <h2 className={`text-xl font-bold ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>Çeviri Ayarları</h2>
                  </div>
                  <button onClick={handleReset} className={`text-sm font-medium flex items-center gap-1.5 transition-colors px-3 py-1.5 rounded-lg border ${isDarkMode ? 'text-slate-300 hover:text-slate-100 bg-slate-800 border-slate-700 hover:bg-slate-700' : 'text-slate-500 hover:text-slate-800 bg-white border-slate-200 hover:bg-slate-50'}`}>
                    <ArrowLeft className="w-4 h-4" /> Dosyayı Değiştir
                  </button>
                </div>

                {cefrStats && (
                  <div className={`mb-8 p-6 rounded-2xl border transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-[#fff5fb] border-pink-100 shadow-sm'}`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg bg-white/50 border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-pink-200'}`}>
                          <span className="text-xl">📊</span>
                        </div>
                        <div>
                          <h3 className={`text-lg font-bold ${isDarkMode ? 'text-slate-100' : 'text-slate-800'}`}>Kitap Zorluk Analizi</h3>
                          <p className={`text-xs ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                            {cefrStats.total.toLocaleString()} kelime • {cefrStats.unique.toLocaleString()} benzersiz • Tahmini seviye: <strong>{cefrStats.B2 > cefrStats.B1 ? 'B2' : 'B1'}</strong>
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-semibold ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>Seviyem:</span>
                        <select 
                          value={userLevel}
                          onChange={(e) => setUserLevel(e.target.value)}
                          className={`text-sm font-bold border rounded-lg px-2 py-1 outline-none ${isDarkMode ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-800'}`}
                        >
                          <option value="A1">A1</option>
                          <option value="A2">A2</option>
                          <option value="B1">B1</option>
                          <option value="B2">B2</option>
                          <option value="C1">C1</option>
                        </select>
                      </div>
                    </div>

                    <div className="w-full h-4 flex rounded-full overflow-hidden mb-6 shadow-inner bg-slate-200/50">
                      <div style={{ width: `${(cefrStats.A1 / cefrStats.total) * 100}%` }} className="bg-[#10b981] h-full flex items-center justify-center text-[8px] font-bold text-white">A1 {Math.round((cefrStats.A1 / cefrStats.total) * 100)}%</div>
                      <div style={{ width: `${(cefrStats.A2 / cefrStats.total) * 100}%` }} className="bg-[#22c55e] h-full flex items-center justify-center text-[8px] font-bold text-white border-l border-white/20">A2 {Math.round((cefrStats.A2 / cefrStats.total) * 100)}%</div>
                      <div style={{ width: `${(cefrStats.B1 / cefrStats.total) * 100}%` }} className="bg-[#f59e0b] h-full flex items-center justify-center text-[8px] font-bold text-white border-l border-white/20">B1 {Math.round((cefrStats.B1 / cefrStats.total) * 100)}%</div>
                      <div style={{ width: `${(cefrStats.B2 / cefrStats.total) * 100}%` }} className="bg-[#f97316] h-full flex items-center justify-center text-[8px] font-bold text-white border-l border-white/20">B2 {Math.round((cefrStats.B2 / cefrStats.total) * 100)}%</div>
                      <div style={{ width: `${(cefrStats.C1 / cefrStats.total) * 100}%` }} className="bg-[#ef4444] h-full flex items-center justify-center text-[8px] font-bold text-white border-l border-white/20">C1 {Math.round((cefrStats.C1 / cefrStats.total) * 100)}%</div>
                    </div>

                    <div className={`p-4 rounded-xl flex items-center gap-3 ${isDarkMode ? 'bg-slate-800/80 border border-slate-700' : 'bg-white border border-slate-100 shadow-sm'}`}>
                      <span className="text-xl">👍</span>
                      <p className={`text-sm ${isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
                        Bu kitabın <strong className="text-blue-600">% {getComprehensionPercentage(cefrStats, userLevel)}</strong>'ini <strong className="bg-blue-100 px-1 rounded">{userLevel}</strong> seviyesinde anlayabilirsiniz.
                      </p>
                    </div>

                    <button 
                      onClick={() => setShowTopWords(!showTopWords)}
                      className={`mt-4 w-full flex items-center gap-2 text-sm font-semibold transition-colors ${isDarkMode ? 'text-slate-400 hover:text-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {showTopWords ? <ChevronDown className="w-4 h-4 text-pink-500" /> : <ChevronRight className="w-4 h-4 text-pink-500" />}
                      <span>🎯 Öğrenilmesi Önerilen En Sık 25 Zor Kelime</span>
                    </button>
                    {showTopWords && cefrStats.topDifficultWords && (
                      <div className="mt-3 flex flex-wrap gap-2 animate-fade-in">
                        {cefrStats.topDifficultWords.map((w, i) => {
                          const isC = w.level === 'C1' || w.level === 'unknown';
                          const isB = w.level === 'B2' || w.level === 'B1';
                          
                          const colorClass = isC 
                            ? (isDarkMode ? 'bg-red-900/30 text-red-300 border-red-800/50' : 'bg-red-50 text-red-700 border-red-100')
                            : isB
                            ? (isDarkMode ? 'bg-orange-900/30 text-orange-300 border-orange-800/50' : 'bg-orange-50 text-orange-700 border-orange-100')
                            : (isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-100 text-slate-600');

                          return (
                            <div key={i} className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all border shadow-sm flex items-center gap-1.5 ${colorClass}`}>
                              <span>{w.word}</span>
                              <span className="text-[10px] opacity-60 font-mono">×{w.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    
                    <div className={`mt-4 flex items-start gap-2 p-3 rounded-lg ${isDarkMode ? 'bg-slate-900/50' : 'bg-slate-50'}`}>
                      <span className="text-sm">💡</span>
                      <p className={`text-[11px] leading-relaxed ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                        Kelimelerin yanındaki sayı kitaptaki sıklığı gösterir. Renkler CEFR zorluk seviyesini temsil eder (Turuncu=B-Seviyesi, Kırmızı=C-Seviyesi veya Bilinmeyen).
                      </p>
                    </div>
                  </div>
                )}
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Kaynak Dil</label>
                    <div className="relative">
                      <select 
                        value={config.sourceLang} 
                        onChange={e => setConfig({...config, sourceLang: e.target.value})}
                        className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 focus:bg-white'}`}
                      >
                        {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Hedef Dil</label>
                    <div className="relative">
                      <select 
                        value={config.targetLang} 
                        onChange={e => setConfig({...config, targetLang: e.target.value})}
                        className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 focus:bg-white'}`}
                      >
                        {LANGUAGES.filter(l => l.code !== 'auto').map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Çeviri Motoru</label>
                    <div className="relative">
                      <select 
                        value={config.engine} 
                        onChange={e => setConfig({...config, engine: e.target.value as EngineType})}
                        className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 focus:bg-white'}`}
                      >
                        <option value="gtx">Google Translate (Ücretsiz)</option>
                        <option value="gtx-fallback">Google Translate + Gemini Yedek</option>
                        <option value="gemini">Gemini AI (API Key Gerekir)</option>
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  </div>

                  {(config.engine === 'gemini' || config.engine === 'gtx-fallback') && (
                    <>
                      <div className="md:col-span-1 space-y-2 animate-fade-in">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Gemini Modeli</label>
                        <div className="relative">
                          <select 
                            value={config.geminiModel} 
                            onChange={e => setConfig({...config, geminiModel: e.target.value})}
                            className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-slate-50 border-slate-300 focus:bg-white'}`}
                          >
                            <option value="gemini-3-flash-preview">Gemini 3 Flash (Hızlı ve Ucuz)</option>
                            <option value="gemini-3.1-flash-lite-preview">Gemini 3.1 Flash-Lite (En Ucuz)</option>
                            <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Yüksek Kalite)</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                        </div>
                      </div>
                      <div className="md:col-span-1 space-y-2 animate-fade-in">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Gemini API Anahtarı</label>
                        <input 
                          type="password" 
                          value={config.apiKey}
                          onChange={e => setConfig({...config, apiKey: e.target.value})}
                          placeholder="API anahtarınızı girin..."
                          className={`w-full border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-300 focus:bg-white placeholder-slate-400'}`}
                        />
                        <p className={`text-xs ${isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>Anahtarınız sadece yerel olarak kullanılır ve asla kaydedilmez.</p>
                      </div>
                    </>
                  )}

                  <div className="md:col-span-2 space-y-3">
                    <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Sayfa Düzeni</label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      {[
                        { id: 'side-by-side', name: 'Yan Yana', desc: 'Orijinal sol, çeviri sağ tarafta', icon: Layout },
                        { id: 'interlinear', name: 'Satır Arası', desc: 'Orijinal altında çeviri', icon: TypeIcon },
                        { id: 'replace', name: 'Sadece Çeviri', desc: 'Orijinal metni çeviriyle değiştir', icon: Globe }
                      ].map(l => (
                        <button
                          key={l.id}
                          onClick={() => setConfig({...config, layout: l.id as LayoutType})}
                          className={`flex flex-col items-start text-left gap-3 p-5 rounded-2xl border-2 transition-all ${config.layout === l.id ? (isDarkMode ? 'border-blue-500 bg-blue-900/30 shadow-sm' : 'border-blue-600 bg-blue-50/50 shadow-sm') : isDarkMode ? 'border-slate-700 bg-slate-900 hover:border-slate-600' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
                        >
                          <div className={`p-2 rounded-lg ${config.layout === l.id ? (isDarkMode ? 'bg-blue-600 text-white' : 'bg-blue-600 text-white') : isDarkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'}`}>
                            <l.icon className="w-5 h-5" />
                          </div>
                          <div>
                            <div className={`font-semibold ${config.layout === l.id ? (isDarkMode ? 'text-blue-300' : 'text-blue-900') : isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{l.name}</div>
                            <div className={`text-xs mt-1 ${config.layout === l.id ? (isDarkMode ? 'text-blue-400/70' : 'text-blue-700/70') : isDarkMode ? 'text-slate-500' : 'text-slate-500'}`}>{l.desc}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {config.layout === 'interlinear' && (
                    <div className={`md:col-span-2 flex gap-6 p-5 rounded-2xl border animate-fade-in ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      <div className="flex-1">
                        <label className={`block text-xs font-semibold mb-2 uppercase tracking-wider ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>Çeviri Arka Planı</label>
                        <div className="flex items-center gap-3">
                          <input type="color" value={config.customBg} onChange={e => setConfig({...config, customBg: e.target.value})} className={`h-10 w-10 rounded cursor-pointer border-0 p-0 ${isDarkMode ? 'bg-slate-800' : ''}`} />
                          <span className={`text-sm font-mono ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{config.customBg}</span>
                        </div>
                      </div>
                      <div className="flex-1">
                        <label className={`block text-xs font-semibold mb-2 uppercase tracking-wider ${isDarkMode ? 'text-slate-400' : 'text-slate-600'}`}>Çeviri Metin Rengi</label>
                        <div className="flex items-center gap-3">
                          <input type="color" value={config.customColor} onChange={e => setConfig({...config, customColor: e.target.value})} className={`h-10 w-10 rounded cursor-pointer border-0 p-0 ${isDarkMode ? 'bg-slate-800' : ''}`} />
                          <span className={`text-sm font-mono ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{config.customColor}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Advanced Translation Settings */}
                  <div className={`md:col-span-2 p-6 rounded-2xl border shadow-sm ${isDarkMode ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                    <h3 className={`text-lg font-bold mb-4 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Gelişmiş Çeviri Ayarları</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Çeviri Tonu</label>
                        <div className="relative">
                          <select 
                            value={config.tone} 
                            onChange={e => setConfig({...config, tone: e.target.value as any})}
                            className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 focus:bg-white'}`}
                          >
                            <option value="default">Varsayılan (Otomatik)</option>
                            <option value="formal">Resmi (Formal)</option>
                            <option value="casual">Samimi (Casual)</option>
                            <option value="literary">Edebi</option>
                            <option value="simple">Basit (Yeni Başlayanlar İçin)</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Özel Sözlük (Opsiyonel)</label>
                        <p className={`text-xs mb-2 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>Özel çeviri kuralları ekleyin. Örnek: <code className="bg-slate-200 dark:bg-slate-700 px-1 rounded">Muggle: Muggle</code></p>
                        <textarea 
                          value={config.customGlossary}
                          onChange={e => setConfig({...config, customGlossary: e.target.value})}
                          placeholder="Hogwarts: Hogwarts&#10;Quidditch: Quidditch"
                          className={`w-full border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all min-h-[100px] ${isDarkMode ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-500' : 'bg-white border-slate-300 placeholder-slate-400'}`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Appearance Settings */}
                  <div className={`md:col-span-2 p-6 rounded-2xl border shadow-sm ${isDarkMode ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                    <h3 className={`text-lg font-bold mb-4 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>Metin Görünümü</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                      <div className="space-y-2">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Font Ailesi</label>
                        <div className="relative">
                          <select 
                            value={config.fontFamily} 
                            onChange={e => setConfig({...config, fontFamily: e.target.value})}
                            className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 focus:bg-white'}`}
                          >
                            <option value="sans-serif">Sans-serif</option>
                            <option value="serif">Serif (Tırnaklı)</option>
                            <option value="monospace">Monospace (Kod Tipi)</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Font Boyutu</label>
                        <div className="relative">
                          <select 
                            value={config.fontSize} 
                            onChange={e => setConfig({...config, fontSize: e.target.value})}
                            className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 focus:bg-white'}`}
                          >
                            <option value="0.9em">Küçük</option>
                            <option value="1em">Orta</option>
                            <option value="1.2em">Büyük</option>
                            <option value="1.5em">Çok Büyük</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className={`block text-sm font-semibold ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Satır Aralığı</label>
                        <div className="relative">
                          <select 
                            value={config.lineSpacing} 
                            onChange={e => setConfig({...config, lineSpacing: e.target.value})}
                            className={`w-full appearance-none border rounded-xl px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all ${isDarkMode ? 'bg-slate-800 border-slate-600 text-white' : 'bg-white border-slate-300 focus:bg-white'}`}
                          >
                            <option value="1.2">Dar</option>
                            <option value="1.5">Normal</option>
                            <option value="1.8">Geniş</option>
                            <option value="2.0">Çok Geniş</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-500">
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={`md:col-span-2 p-6 rounded-2xl border shadow-sm ${isDarkMode ? 'bg-emerald-900/20 border-emerald-800/50' : 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100'}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex items-center h-6">
                        <input 
                          type="checkbox" 
                          id="glossary" 
                          checked={config.buildGlossary} 
                          onChange={e => setConfig({...config, buildGlossary: e.target.checked})}
                          className={`w-5 h-5 rounded cursor-pointer ${isDarkMode ? 'text-emerald-500 border-emerald-700 focus:ring-emerald-500 bg-slate-800' : 'text-emerald-600 border-emerald-300 focus:ring-emerald-500'}`}
                        />
                      </div>
                      <div className="flex-1">
                        <label htmlFor="glossary" className={`text-base font-bold cursor-pointer block ${isDarkMode ? 'text-emerald-400' : 'text-emerald-900'}`}>
                          Akıllı Sözlük Oluşturma
                        </label>
                        <p className={`text-sm mt-1 ${isDarkMode ? 'text-emerald-200/70' : 'text-emerald-700/80'}`}>Zor kelimeleri ve deyimleri otomatik olarak ayıklar ve kitabın sonuna bir sözlük bölümü ekler.</p>
                      </div>
                    </div>
                    
                    {config.buildGlossary && (
                      <div className={`mt-6 pt-6 border-t space-y-5 animate-fade-in ${isDarkMode ? 'border-emerald-800/50' : 'border-emerald-200/60'}`}>
                        <div>
                          <label className={`block text-sm font-semibold mb-2 ${isDarkMode ? 'text-emerald-300' : 'text-emerald-900'}`}>Minimum Kelime Seviyesi (CEFR)</label>
                          <div className="relative w-full md:w-2/3">
                            <select 
                              value={config.minCefrLevel} 
                              onChange={e => setConfig({...config, minCefrLevel: e.target.value as any})}
                              className={`w-full appearance-none border rounded-xl px-4 py-2.5 focus:ring-2 outline-none text-sm shadow-sm ${isDarkMode ? 'bg-slate-900 border-emerald-700/50 text-slate-200 focus:ring-emerald-500' : 'bg-white border-emerald-200 text-emerald-900 focus:ring-emerald-500'}`}
                            >
                              <option value="A1">A1-A2 (Temel kelimeleri dahil et)</option>
                              <option value="B1">B1-B2 (Sadece orta seviye kelimeler)</option>
                              <option value="C1">C1-C2 (Sadece ileri seviye kelimeler)</option>
                            </select>
                            <div className={`pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 ${isDarkMode ? 'text-emerald-500' : 'text-emerald-600'}`}>
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                            </div>
                          </div>
                        </div>
                        
                        <div className="space-y-3">
                          <label className="flex items-start gap-3 cursor-pointer group">
                            <div className="flex items-center h-5 mt-0.5">
                              <input 
                                type="checkbox" 
                                checked={config.extractIdioms} 
                                onChange={e => setConfig({...config, extractIdioms: e.target.checked})}
                                className={`w-4 h-4 rounded ${isDarkMode ? 'text-emerald-500 border-emerald-700 focus:ring-emerald-500 bg-slate-800' : 'text-emerald-600 border-emerald-300 focus:ring-emerald-500'}`}
                              />
                            </div>
                            <div>
                              <span className={`text-sm font-medium ${isDarkMode ? 'text-emerald-300 group-hover:text-emerald-200' : 'text-emerald-900 group-hover:text-emerald-700'}`}>Extract Idioms & Phrasal Verbs</span>
                              <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-emerald-200/60' : 'text-emerald-700/70'}`}>Highlights idioms in the text in <span className="text-blue-500 font-bold">blue</span>.</p>
                            </div>
                          </label>

                          <label className="flex items-start gap-3 cursor-pointer group">
                            <div className="flex items-center h-5 mt-0.5">
                              <input 
                                type="checkbox" 
                                checked={config.contextualGlossary} 
                                onChange={e => setConfig({...config, contextualGlossary: e.target.checked})}
                                className={`w-4 h-4 rounded ${isDarkMode ? 'text-emerald-500 border-emerald-700 focus:ring-emerald-500 bg-slate-800' : 'text-emerald-600 border-emerald-300 focus:ring-emerald-500'}`}
                              />
                            </div>
                            <div>
                              <span className={`text-sm font-medium ${isDarkMode ? 'text-emerald-300 group-hover:text-emerald-200' : 'text-emerald-900 group-hover:text-emerald-700'}`}>Contextual Examples</span>
                              <p className={`text-xs mt-0.5 ${isDarkMode ? 'text-emerald-200/60' : 'text-emerald-700/70'}`}>Include the sentence where the word was found in the glossary.</p>
                            </div>
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-4 space-y-6">
              <div className={`p-6 rounded-3xl shadow-sm border max-h-[800px] flex flex-col sticky top-24 ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className={`flex items-center justify-between mb-4 pb-4 border-b ${isDarkMode ? 'border-slate-700' : 'border-slate-100'}`}>
                  <h2 className={`text-lg font-bold flex items-center gap-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                    <Book className="w-5 h-5 text-blue-500"/> 
                    Bölümler
                  </h2>
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${isDarkMode ? 'bg-blue-900/50 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
                    {chapters.filter(c => c.selected).length} seçildi
                  </span>
                </div>
                
                <div className="overflow-y-auto flex-1 pr-2 space-y-1.5 custom-scrollbar">
                  {chapters.map(ch => (
                    <label key={ch.id} className={`flex items-start gap-3 p-3 rounded-xl border transition-all cursor-pointer ${ch.selected ? (isDarkMode ? 'bg-blue-900/30 border-blue-700/50' : 'bg-blue-50/50 border-blue-200') : (isDarkMode ? 'bg-slate-800 border-transparent hover:bg-slate-700 hover:border-slate-600' : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-200')}`}>
                      <div className="flex items-center h-5 mt-0.5">
                        <input 
                          type="checkbox" 
                          checked={ch.selected}
                          onChange={e => setChapters(prev => prev.map(c => c.id === ch.id ? {...c, selected: e.target.checked} : c))}
                          className={`w-4 h-4 rounded focus:ring-blue-500 ${isDarkMode ? 'text-blue-500 border-slate-600 bg-slate-700' : 'text-blue-600 border-slate-300'}`}
                        />
                      </div>
                      <span className={`text-sm line-clamp-2 ${ch.selected ? (isDarkMode ? 'text-blue-300 font-medium' : 'text-blue-900 font-medium') : (isDarkMode ? 'text-slate-400' : 'text-slate-600')}`}>{ch.title}</span>
                      {ch.status === 'done' && <Check className="w-4 h-4 text-emerald-500 ml-auto" />}
                    </label>
                  ))}
                </div>

                <div className={`pt-6 mt-4 border-t ${isDarkMode ? 'border-slate-700' : 'border-slate-100'}`}>
                  <button 
                    onClick={processBook}
                    disabled={chapters.filter(c => c.selected).length === 0}
                    className={`w-full font-bold py-4 px-4 rounded-2xl transition-all shadow-sm hover:shadow flex items-center justify-center gap-2 text-lg disabled:cursor-not-allowed ${isDarkMode ? 'bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:border disabled:border-slate-700 text-white' : 'bg-blue-600 hover:bg-blue-700 disabled:bg-slate-100 disabled:text-slate-400 text-white'}`}
                  >
                    <Play className="w-5 h-5" />
                    Çeviriyi Başlat
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3 & 4: PROCESSING & PREVIEW */}
        {(step === 3 || step === 4) && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-[calc(100vh-140px)] animate-slide-up">
            <div className="lg:col-span-3 flex flex-col gap-6">
              {step === 3 ? (
                <div className={`p-8 rounded-3xl shadow-md text-center relative overflow-hidden ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'} border`}>
                  <div className="relative w-24 h-24 mx-auto mb-6">
                    <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="45" fill="none" stroke={isDarkMode ? "#334155" : "#f1f5f9"} strokeWidth="6" />
                      <circle 
                        cx="50" cy="50" r="45" fill="none" stroke="#2563eb" strokeWidth="6" 
                        strokeLinecap="round"
                        strokeDasharray={`${2 * Math.PI * 45}`} 
                        strokeDashoffset={`${2 * Math.PI * 45 * (1 - progress.current / Math.max(1, progress.total))}`} 
                        className="transition-all duration-700 ease-out"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center flex-col">
                      <span className={`text-xl font-black tracking-tight ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                        {Math.round((progress.current / Math.max(1, progress.total)) * 100)}<span className="text-sm">%</span>
                      </span>
                    </div>
                    {!isPaused && (
                      <div className="absolute inset-0 rounded-full border-4 border-blue-500/20 animate-ping" style={{ animationDuration: '3s' }}></div>
                    )}
                  </div>
                  
                  <h2 className={`text-xl font-bold mb-2 tracking-tight ${isDarkMode ? 'text-slate-100' : 'text-slate-900'}`}>
                    {isPaused ? 'Durduruldu' : 'Çevriliyor...'}
                  </h2>
                  <p className={`mb-6 text-sm truncate px-4 ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                    {isPaused ? 'Devam etmek için Başlat\'a tıklayın.' : progress.chapterTitle}
                  </p>
                  
                  <div className="flex flex-col gap-3 max-w-xs mx-auto">
                    {isPaused ? (
                      <button onClick={handleResume} className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-sm">
                        <Play className="w-4 h-4" fill="currentColor" /> Başlat
                      </button>
                    ) : (
                      <button onClick={handlePause} className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-bold transition-all ${isDarkMode ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
                        <Pause className="w-4 h-4" fill="currentColor" /> Duraklat
                      </button>
                    )}

                    <button 
                      onClick={handleCancelTranslation} 
                      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-bold transition-all border ${isDarkMode ? 'border-red-900/30 text-red-400 hover:bg-red-900/20' : 'border-red-100 text-red-600 hover:bg-red-50'}`}
                    >
                      <X className="w-4 h-4" /> Çeviriyi İptal Et
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`p-8 rounded-3xl shadow-md text-center relative overflow-hidden ${isDarkMode ? 'bg-gradient-to-br from-blue-900 to-indigo-900 text-slate-100' : 'bg-gradient-to-br from-blue-600 to-indigo-700 text-white'}`}>
                  <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-white/10 rounded-full blur-2xl"></div>
                  <div className="absolute bottom-0 left-0 -mb-4 -ml-4 w-24 h-24 bg-black/10 rounded-full blur-2xl"></div>
                  
                  <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center mx-auto mb-5 relative z-10">
                    <CheckCircle className="w-8 h-8 text-white" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2 relative z-10">Tebrikler!</h2>
                  <p className={`text-sm mb-8 relative z-10 ${isDarkMode ? 'text-blue-200' : 'text-blue-100'}`}>İki dilli kitabınız hazır.</p>
                  <button 
                    onClick={downloadEpub}
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl font-bold transition-all shadow-sm relative z-10 ${isDarkMode ? 'bg-slate-800 text-blue-300 hover:bg-slate-700' : 'bg-white text-blue-700 hover:bg-blue-50'}`}
                  >
                    <Download className="w-5 h-5" />
                    EPUB Olarak İndir
                  </button>
                  <button 
                    onClick={handleReset}
                    className={`w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl font-bold transition-all mt-3 relative z-10 ${isDarkMode ? 'bg-blue-800/50 text-blue-200 hover:bg-blue-700/50' : 'bg-blue-700/30 text-white hover:bg-blue-700/50'}`}
                  >
                    <RotateCcw className="w-5 h-5" />
                    Başka Bir Kitap Çevir
                  </button>
                </div>
              )}

              <div className={`rounded-3xl shadow-sm border flex-1 overflow-hidden flex flex-col ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className={`p-5 border-b ${isDarkMode ? 'border-slate-700 bg-slate-800/50' : 'border-slate-100 bg-slate-50/50'}`}>
                  <h3 className={`font-bold flex items-center gap-2 ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}><FileText className="w-5 h-5 text-blue-500"/> Bölüm Önizlemeleri</h3>
                </div>
                <div className="overflow-y-auto p-3 flex-1 space-y-1 custom-scrollbar">
                  {Object.keys(previews).map(id => {
                    const ch = chapters.find(c => c.id === id);
                    const title = id === 'auto-glossary' ? 'Sözlük (Otomatik)' : (ch?.title || id);
                    return (
                      <button
                        key={id}
                        onClick={() => setActivePreviewId(id)}
                        className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-all flex items-center justify-between ${activePreviewId === id ? (isDarkMode ? 'bg-blue-900/40 text-blue-300 font-semibold shadow-sm border border-blue-700/50' : 'bg-blue-50 text-blue-700 font-semibold shadow-sm border border-blue-100') : (isDarkMode ? 'text-slate-400 hover:bg-slate-700 border border-transparent' : 'text-slate-600 hover:bg-slate-50 border border-transparent')}`}
                      >
                        <span className="truncate">{title}</span>
                        {ch?.status === 'done' && <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0 ml-2" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className={`lg:col-span-9 rounded-3xl shadow-sm border overflow-hidden flex flex-col ${isDarkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className={`px-6 py-4 border-b flex justify-between items-center ${isDarkMode ? 'border-slate-700 bg-slate-800/50' : 'border-slate-100 bg-slate-50/50'}`}>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-3 h-3 rounded-full bg-red-400"></div>
                    <div className="w-3 h-3 rounded-full bg-amber-400"></div>
                    <div className="w-3 h-3 rounded-full bg-green-400"></div>
                  </div>
                  <span className={`font-semibold ml-2 ${isDarkMode ? 'text-slate-300' : 'text-slate-700'}`}>Live Preview</span>
                </div>
                <div className="flex items-center gap-3">
                  {activePreviewId && previews[activePreviewId] && (
                    <button 
                      onClick={handleTTS}
                      className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors ${isSpeaking ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50' : 'bg-blue-100 text-blue-600 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50'}`}
                    >
                      {isSpeaking ? <Square className="w-3.5 h-3.5 fill-current" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {isSpeaking ? 'Okumayı Durdur' : 'Sesli Oku'}
                    </button>
                  )}
                  <span className={`text-xs font-medium px-3 py-1 rounded-full border hidden sm:inline-block ${isDarkMode ? 'text-slate-400 bg-slate-800 border-slate-700' : 'text-slate-400 bg-white border-slate-200'}`}>E-kitap okuyucularda görünüm biraz farklılık gösterebilir.</span>
                </div>
              </div>
              <div className={`flex-1 overflow-y-auto p-10 custom-scrollbar flex justify-center relative ${isDarkMode ? 'bg-[#0f172a]' : 'bg-[#f8fafc]'}`}>
                {activePreviewId && previews[activePreviewId] ? (
                  <div 
                    className={`prose prose-lg max-w-3xl w-full ${isDarkMode ? 'prose-invert prose-slate' : 'prose-slate'}`}
                    style={{
                      fontFamily: config.fontFamily,
                      fontSize: config.fontSize,
                      lineHeight: config.lineSpacing
                    }}
                    onMouseUp={handleTextSelection}
                    dangerouslySetInnerHTML={{ __html: previews[activePreviewId] }}
                  />
                ) : (
                  <div className={`h-full flex flex-col items-center justify-center space-y-4 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    <BookOpen className="w-12 h-12 opacity-20" />
                    <p>Önizlemek için kenar çubuğundan bir bölüm seçin</p>
                  </div>
                )}

                {/* Dictionary Popup */}
                {dictionaryWord && (
                  <div 
                    className={`dictionary-popup fixed z-50 p-4 rounded-xl shadow-2xl border max-w-sm w-full -translate-x-1/2 mt-2 animate-fade-in ${isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-slate-200 text-slate-800'}`}
                    style={{ left: dictionaryPos.x, top: dictionaryPos.y }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-bold text-lg text-blue-500">{dictionaryWord}</h4>
                      <button onClick={() => setDictionaryWord(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    
                    {dictionaryLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    ) : dictionaryData ? (
                      <div className="space-y-3 max-h-60 overflow-y-auto custom-scrollbar pr-2">
                        {dictionaryData.phonetics?.[0]?.text && (
                          <p className="text-sm text-slate-500 font-mono">{dictionaryData.phonetics[0].text}</p>
                        )}
                        {dictionaryData.meanings?.slice(0, 2).map((meaning: any, i: number) => (
                          <div key={i}>
                            <span className={`text-xs font-bold uppercase tracking-wider ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{meaning.partOfSpeech}</span>
                            <ul className="list-disc pl-4 mt-1 space-y-1">
                              {meaning.definitions.slice(0, 2).map((def: any, j: number) => (
                                <li key={j} className="text-sm">{def.definition}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500 py-2">Tanım bulunamadı.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
          </div>
        )}
      </main>
    </div>
  );
}