export interface TranslationPayload {
  id: number;
  text: string;
}

export interface TranslationResult {
  id: number;
  translation: string;
}

export type LayoutType = 'side-by-side' | 'columns' | 'interlinear' | 'replace';
export type EngineType = 'gtx' | 'gemini' | 'gtx-fallback';

export interface Chapter {
  id: string;
  title: string;
  href: string;
  fullPath: string;
  selected: boolean;
  status: 'pending' | 'processing' | 'done' | 'error';
}

export interface AppConfig {
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

export interface GlossaryTerm {
  source: string;
  target: string;
  type: 'word' | 'idiom';
  contextEn: string;
  contextTr: string;
}
