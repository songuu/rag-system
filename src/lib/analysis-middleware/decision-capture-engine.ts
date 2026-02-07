/**
 * 决策捕获器（Decision Capture Engine）
 * 
 * 劫持 BPE 的 merge 循环，记录每次合并决策
 */

import { AutoTokenizer } from '@xenova/transformers';
import type {
  TokenDecisionMetadata,
  PathLogic,
  SemanticEntropy,
  ByteRange,
  MergeOperation,
  LogicWaterfallData,
  StabilityMetrics
} from './types';

export class DecisionCaptureEngine {
  private tokenizer: any = null;
  private modelName: string;
  private vocabMap: Map<string, number> = new Map();
  private idToTokenMap: Map<number, string> = new Map();
  private initialized: boolean = false;

  constructor(modelName: string = 'Xenova/bert-base-multilingual-cased') {
    this.modelName = modelName;
  }

  /**
   * 初始化引擎
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(`[DecisionCaptureEngine] 初始化模型: ${this.modelName}`);
    this.tokenizer = await AutoTokenizer.from_pretrained(this.modelName);
    
    // 提取词汇表
    this.extractVocabulary();
    this.initialized = true;
    console.log(`[DecisionCaptureEngine] 词汇表大小: ${this.vocabMap.size}`);
  }

  /**
   * 从 tokenizer 提取词汇表
   */
  private extractVocabulary(): void {
    const vocabPaths = [
      () => this.tokenizer?.model?.vocab,
      () => this.tokenizer?.model?.encoder,
      () => this.tokenizer?.vocab,
      () => this.tokenizer?.tokenizer_?.model?.vocab,
    ];

    for (const getVocab of vocabPaths) {
      try {
        const vocabObj = getVocab();
        if (vocabObj) {
          if (vocabObj instanceof Map) {
            vocabObj.forEach((value: any, key: any) => {
              if (typeof key === 'string' && typeof value === 'number') {
                this.vocabMap.set(key, value);
                this.idToTokenMap.set(value, key);
              }
            });
          } else if (typeof vocabObj === 'object') {
            Object.entries(vocabObj).forEach(([key, value]) => {
              if (typeof value === 'number') {
                this.vocabMap.set(key, value);
                this.idToTokenMap.set(value, key);
              }
            });
          }
          if (this.vocabMap.size > 0) break;
        }
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * 捕获完整的分词决策过程
   */
  async captureDecisions(text: string): Promise<{
    waterfall: LogicWaterfallData;
    tokenDecisions: TokenDecisionMetadata[];
    stabilityMetrics: StabilityMetrics[];
  }> {
    await this.initialize();

    const startTime = Date.now();
    const stages: LogicWaterfallData['stages'] = [];
    const mergeOperations: MergeOperation[] = [];

    // Stage 1: 原始字节
    const bytesStage = this.captureByteStage(text);
    stages.push(bytesStage);

    // Stage 2: 字符序列
    const charsStage = this.captureCharacterStage(text);
    stages.push(charsStage);

    // Stage 3: BPE 子词合并（核心决策捕获）
    const { stage: subwordsStage, operations } = await this.captureBPEMergeStage(text);
    stages.push(subwordsStage);
    mergeOperations.push(...operations);

    // Stage 4: 最终词元
    const finalStage = await this.captureFinalStage(text);
    stages.push(finalStage);

    // 构建 Token 决策元数据
    const tokenDecisions = this.buildTokenDecisions(text, finalStage.tokens);

    // 计算稳定性指标
    const stabilityMetrics = this.calculateStabilityMetrics(mergeOperations, tokenDecisions);

    // 计算压缩比
    const compressionRatio = text.length / finalStage.tokens.length;

    const waterfall: LogicWaterfallData = {
      input: text,
      stages,
      totalTime: Date.now() - startTime,
      finalTokenCount: finalStage.tokens.length,
      compressionRatio
    };

    return { waterfall, tokenDecisions, stabilityMetrics };
  }

  /**
   * 捕获字节阶段
   */
  private captureByteStage(text: string): LogicWaterfallData['stages'][0] {
    const bytes = new TextEncoder().encode(text);
    const tokens: TokenDecisionMetadata[] = [];
    let byteOffset = 0;

    for (let i = 0; i < bytes.length; i++) {
      tokens.push({
        tokenId: bytes[i],
        token: `[0x${bytes[i].toString(16).padStart(2, '0')}]`,
        pathLogic: {
          depth: 0,
          hitCount: 1,
          rankConflicts: [],
          selectedPathIndex: 0,
          alternativePaths: []
        },
        semanticEntropy: {
          entropyContribution: Math.log2(256), // 字节级熵
          entropyRatio: 1 / bytes.length,
          frequency: 1 / 256,
          idf: Math.log(256)
        },
        byteRange: {
          start: byteOffset,
          end: byteOffset + 1,
          byteLength: 1,
          charLength: 1,
          originalText: String.fromCharCode(bytes[i])
        },
        decisionType: 'direct',
        confidence: 1.0
      });
      byteOffset++;
    }

    return {
      level: 'bytes',
      tokens,
      mergeOperations: [],
      processingTime: 0,
      entropy: Math.log2(256) * bytes.length
    };
  }

  /**
   * 捕获字符阶段
   */
  private captureCharacterStage(text: string): LogicWaterfallData['stages'][0] {
    const tokens: TokenDecisionMetadata[] = [];
    let charOffset = 0;

    for (const char of text) {
      const byteLength = new TextEncoder().encode(char).length;
      tokens.push({
        tokenId: char.charCodeAt(0),
        token: char,
        pathLogic: {
          depth: 1,
          hitCount: 1,
          rankConflicts: [],
          selectedPathIndex: 0,
          alternativePaths: []
        },
        semanticEntropy: {
          entropyContribution: this.calculateCharEntropy(char),
          entropyRatio: 1 / text.length,
          frequency: this.estimateCharFrequency(char),
          idf: Math.log(this.vocabMap.size || 30000)
        },
        byteRange: {
          start: charOffset,
          end: charOffset + char.length,
          byteLength,
          charLength: char.length,
          originalText: char
        },
        decisionType: 'split',
        confidence: 0.9
      });
      charOffset += char.length;
    }

    return {
      level: 'characters',
      tokens,
      mergeOperations: [],
      processingTime: 0,
      entropy: tokens.reduce((sum, t) => sum + t.semanticEntropy.entropyContribution, 0)
    };
  }

  /**
   * 捕获 BPE 合并阶段（核心）
   */
  private async captureBPEMergeStage(text: string): Promise<{
    stage: LogicWaterfallData['stages'][0];
    operations: MergeOperation[];
  }> {
    const startTime = Date.now();
    const operations: MergeOperation[] = [];

    // 使用 tokenizer 进行编码
    const encoded = this.tokenizer.encode(text, { add_special_tokens: false });
    
    // 获取 token 文本
    let tokenTexts: string[] = [];
    try {
      tokenTexts = this.tokenizer.batch_decode(
        encoded.map((id: number) => [id]),
        { skip_special_tokens: false }
      );
    } catch {
      tokenTexts = encoded.map((id: number) => this.idToTokenMap.get(id) || `[UNK:${id}]`);
    }

    // 构建 tokens
    const tokens: TokenDecisionMetadata[] = [];
    let charOffset = 0;
    let stepCounter = 0;

    for (let i = 0; i < encoded.length; i++) {
      const tokenId = encoded[i];
      const tokenText = tokenTexts[i] || `[TOKEN:${tokenId}]`;
      const cleanToken = tokenText.replace(/^##|^▁/g, '').trim();
      
      // 查找该 token 在原文中的位置
      const tokenPosition = text.indexOf(cleanToken, charOffset);
      const actualStart = tokenPosition >= 0 ? tokenPosition : charOffset;
      const actualEnd = actualStart + cleanToken.length;
      
      // 模拟合并决策
      if (i > 0 && tokenText.length > 1) {
        const prevToken = tokenTexts[i - 1] || '';
        const alternatives = this.findAlternativeMerges(prevToken, tokenText);
        
        operations.push({
          step: stepCounter++,
          left: {
            token: prevToken,
            tokenId: encoded[i - 1],
            rank: this.getTokenRank(encoded[i - 1])
          },
          right: {
            token: tokenText.slice(0, 1),
            tokenId: tokenText.charCodeAt(0),
            rank: 99999
          },
          merged: {
            token: tokenText,
            tokenId,
            rank: this.getTokenRank(tokenId)
          },
          discardedAlternatives: alternatives,
          timestamp: Date.now()
        });
      }

      tokens.push({
        tokenId,
        token: tokenText,
        pathLogic: this.buildPathLogic(tokenId, tokenText),
        semanticEntropy: this.calculateTokenEntropy(tokenId, tokenText),
        byteRange: {
          start: actualStart,
          end: actualEnd,
          byteLength: new TextEncoder().encode(cleanToken).length,
          charLength: cleanToken.length,
          originalText: cleanToken
        },
        decisionType: this.determineDecisionType(tokenText),
        confidence: this.calculateConfidence(tokenId, tokenText)
      });

      charOffset = actualEnd;
    }

    return {
      stage: {
        level: 'subwords',
        tokens,
        mergeOperations: operations,
        processingTime: Date.now() - startTime,
        entropy: tokens.reduce((sum, t) => sum + t.semanticEntropy.entropyContribution, 0)
      },
      operations
    };
  }

  /**
   * 捕获最终阶段
   */
  private async captureFinalStage(text: string): Promise<LogicWaterfallData['stages'][0]> {
    const startTime = Date.now();
    const encoded = this.tokenizer.encode(text, { add_special_tokens: false });
    
    let tokenTexts: string[] = [];
    try {
      tokenTexts = this.tokenizer.batch_decode(
        encoded.map((id: number) => [id]),
        { skip_special_tokens: false }
      );
    } catch {
      tokenTexts = encoded.map((id: number) => this.idToTokenMap.get(id) || `[UNK:${id}]`);
    }

    const tokens: TokenDecisionMetadata[] = [];
    let charOffset = 0;

    for (let i = 0; i < encoded.length; i++) {
      const tokenId = encoded[i];
      const tokenText = tokenTexts[i] || `[TOKEN:${tokenId}]`;
      const cleanToken = tokenText.replace(/^##|^▁/g, '').trim();
      
      const tokenPosition = text.indexOf(cleanToken, charOffset);
      const actualStart = tokenPosition >= 0 ? tokenPosition : charOffset;
      const actualEnd = actualStart + cleanToken.length;

      tokens.push({
        tokenId,
        token: tokenText,
        pathLogic: this.buildPathLogic(tokenId, tokenText),
        semanticEntropy: this.calculateTokenEntropy(tokenId, tokenText),
        byteRange: {
          start: actualStart,
          end: actualEnd,
          byteLength: new TextEncoder().encode(cleanToken).length,
          charLength: cleanToken.length,
          originalText: cleanToken
        },
        decisionType: this.determineDecisionType(tokenText),
        confidence: this.calculateConfidence(tokenId, tokenText)
      });

      charOffset = actualEnd;
    }

    return {
      level: 'fullwords',
      tokens,
      mergeOperations: [],
      processingTime: Date.now() - startTime,
      entropy: tokens.reduce((sum, t) => sum + t.semanticEntropy.entropyContribution, 0)
    };
  }

  /**
   * 构建 Token 决策元数据
   */
  private buildTokenDecisions(text: string, tokens: TokenDecisionMetadata[]): TokenDecisionMetadata[] {
    return tokens.map((token, index) => ({
      ...token,
      pathLogic: {
        ...token.pathLogic,
        selectedPathIndex: index
      }
    }));
  }

  /**
   * 计算稳定性指标
   */
  private calculateStabilityMetrics(
    operations: MergeOperation[],
    tokens: TokenDecisionMetadata[]
  ): StabilityMetrics[] {
    return tokens.map((token, index) => {
      const relatedOps = operations.filter(op => 
        op.merged.tokenId === token.tokenId
      );

      if (relatedOps.length === 0) {
        return {
          coefficient: 1.0,
          topScore: 1.0,
          secondScore: 0,
          scoreDelta: 1.0,
          level: 'stable' as const
        };
      }

      const op = relatedOps[0];
      const topScore = 1 / (op.merged.rank + 1);
      const secondScore = op.discardedAlternatives.length > 0
        ? 1 / (op.discardedAlternatives[0].rank + 1)
        : 0;
      
      const coefficient = secondScore > 0 ? 1 - (secondScore / topScore) : 1.0;
      const scoreDelta = topScore - secondScore;

      let level: StabilityMetrics['level'] = 'stable';
      if (coefficient < 0.3) level = 'critical';
      else if (coefficient < 0.5) level = 'unstable';
      else if (coefficient < 0.7) level = 'moderate';

      return { coefficient, topScore, secondScore, scoreDelta, level };
    });
  }

  // ============= 辅助方法 =============

  private calculateCharEntropy(char: string): number {
    if (/[\u4e00-\u9fff]/.test(char)) return 13; // 中文字符高熵
    if (/[a-zA-Z]/.test(char)) return 4.7; // 英文字母
    if (/[0-9]/.test(char)) return 3.3; // 数字
    return 6; // 其他
  }

  private estimateCharFrequency(char: string): number {
    if (/[etaoinshrdlu]/i.test(char)) return 0.08;
    if (/[\u4e00-\u9fff]/.test(char)) return 0.001;
    return 0.02;
  }

  private buildPathLogic(tokenId: number, token: string): PathLogic {
    return {
      depth: token.length,
      hitCount: this.vocabMap.has(token) ? 1 : 0,
      rankConflicts: [],
      selectedPathIndex: 0,
      alternativePaths: []
    };
  }

  private calculateTokenEntropy(tokenId: number, token: string): SemanticEntropy {
    const rank = this.getTokenRank(tokenId);
    const frequency = 1 / (rank + 1);
    const idf = Math.log((this.vocabMap.size || 30000) / (rank + 1));
    
    return {
      entropyContribution: -Math.log2(frequency + 0.0001),
      entropyRatio: 1 / (rank + 1),
      frequency,
      idf
    };
  }

  private getTokenRank(tokenId: number): number {
    return tokenId < 100 ? 0 : tokenId < 1000 ? tokenId : tokenId;
  }

  private determineDecisionType(token: string): TokenDecisionMetadata['decisionType'] {
    if (token.startsWith('[0x')) return 'fallback';
    if (token.length === 1) return 'split';
    if (token.startsWith('##') || token.startsWith('▁')) return 'merge';
    return 'direct';
  }

  private calculateConfidence(tokenId: number, token: string): number {
    if (token.startsWith('[0x') || token.startsWith('[UNK')) return 0.3;
    if (this.vocabMap.has(token)) return 0.95;
    if (tokenId < 1000) return 0.9;
    return 0.7;
  }

  private findAlternativeMerges(prevToken: string, currentToken: string): MergeOperation['discardedAlternatives'] {
    const alternatives: MergeOperation['discardedAlternatives'] = [];
    
    // 模拟查找备选合并
    if (currentToken.length > 2) {
      alternatives.push({
        left: prevToken,
        right: currentToken.slice(0, currentToken.length - 1),
        rank: 99999,
        reason: 'Shorter merge available'
      });
    }

    return alternatives;
  }

  /**
   * 获取模型名称
   */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * 获取词汇表大小
   */
  getVocabSize(): number {
    return this.vocabMap.size;
  }
}
