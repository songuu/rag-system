declare module '@llamaindex/liteparse' {
  export interface LiteParseOptions {
    ocrEnabled?: boolean;
    maxPages?: number;
    targetPages?: string;
    password?: string;
    outputFormat?: 'json' | 'markdown' | 'text';
    quiet?: boolean;
  }

  export interface LiteParseTextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface LiteParsePage {
    text?: string;
    textItems?: LiteParseTextItem[];
  }

  export interface LiteParseResult {
    text?: string;
    pages: LiteParsePage[];
  }

  export class LiteParse {
    constructor(options?: LiteParseOptions);
    parse(input: Buffer | Uint8Array | ArrayBuffer): Promise<LiteParseResult>;
  }
}
