export interface TranslationPayload {
  id: number;
  text: string;
}

export interface TranslationResult {
  id: number;
  translation: string;
}

export type LayoutType = 'side-by-side' | 'columns' | 'interlinear' | 'replace';
// 'llm': an open-source model through an OpenAI-compatible server; 'gtx-fallback': Google first, the model when it fails.
export type EngineType = 'gtx' | 'llm' | 'gtx-fallback';

export type SimplifyLevel = 'off' | 'A2' | 'B1' | 'B2';

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
  llmProvider: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  // Keys per service (provider id -> key); llmApiKey is the one for the selected service.
  llmKeys: Record<string, string>;
  simplifyLevel: SimplifyLevel;
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
