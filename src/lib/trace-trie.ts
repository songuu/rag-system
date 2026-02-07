/**
 * Trace-Trie 全路径监测系统
 * 用于追踪和分析 BPE 分词决策过程
 */

// Trie 树节点接口
export interface TrieNode {
  char: string;
  children: Map<string, TrieNode>;
  tokenId?: number;
  mergeRank?: number;
  frequency?: number;
  isTerminal: boolean;
  traceAnchors: TraceAnchor[];
}

// Trace 锚点 - 记录决策点
export interface TraceAnchor {
  position: number;
  decisionType: 'merge' | 'split' | 'fallback';
  candidates: CandidateInfo[];
  selectedCandidate: string;
  reason: string;
  timestamp: number;
}

// 候选信息
export interface CandidateInfo {
  token: string;
  tokenId: number;
  mergeRank: number;
  frequency: number;
  score: number;
}

// 分词决策路径
export interface TokenizationPath {
  level: 'bytes' | 'characters' | 'subwords' | 'fullwords';
  tokens: PathToken[];
  timestamp: number;
}

// 路径中的 Token
export interface PathToken {
  token: string;
  tokenId: number;
  byteLength: number;
  mergeRank?: number;
  frequency?: number;
  decisionPoint?: TraceAnchor;
}

// 逻辑瀑布流数据
export interface LogicWaterfall {
  input: string;
  stages: WaterfallStage[];
  totalTime: number;
}

// 瀑布流阶段
export interface WaterfallStage {
  level: 'bytes' | 'characters' | 'subwords' | 'fullwords';
  tokens: PathToken[];
  processingTime: number;
  mergeOperations: MergeOperation[];
}

// 合并操作
export interface MergeOperation {
  left: string;
  right: string;
  merged: string;
  rank: number;
  reason: string;
  timestamp: number;
}

/**
 * 增强型 Trie 树类
 */
export class EnhancedTrie {
  private root: TrieNode;
  private vocabSize: number = 0;

  constructor() {
    this.root = {
      char: '',
      children: new Map(),
      isTerminal: false,
      traceAnchors: []
    };
  }

  /**
   * 从词汇表构建 Trie 树
   */
  buildFromVocabulary(vocab: Map<string, { id: number; rank: number; frequency: number }>): void {
    this.vocabSize = vocab.size;
    
    for (const [token, metadata] of vocab.entries()) {
      this.insert(token, metadata.id, metadata.rank, metadata.frequency);
    }
  }

  /**
   * 插入词元到 Trie 树
   */
  private insert(token: string, tokenId: number, mergeRank: number, frequency: number): void {
    let node = this.root;
    
    for (let i = 0; i < token.length; i++) {
      const char = token[i];
      
      if (!node.children.has(char)) {
        node.children.set(char, {
          char,
          children: new Map(),
          isTerminal: false,
          traceAnchors: []
        });
      }
      
      node = node.children.get(char)!;
    }
    
    // 标记为终止节点
    node.isTerminal = true;
    node.tokenId = tokenId;
    node.mergeRank = mergeRank;
    node.frequency = frequency;
  }

  /**
   * 查找最长匹配
   */
  findLongestMatch(text: string, startPos: number): {
    match: string;
    tokenId: number;
    mergeRank: number;
    frequency: number;
    traceAnchor: TraceAnchor;
  } | null {
    let node = this.root;
    let bestMatch = '';
    let bestTokenId = -1;
    let bestMergeRank = Infinity;
    let bestFrequency = 0;
    let candidates: CandidateInfo[] = [];
    
    for (let i = startPos; i < text.length; i++) {
      const char = text[i];
      
      if (!node.children.has(char)) {
        break;
      }
      
      node = node.children.get(char)!;
      
      // 如果这是一个终止节点，记录为候选
      if (node.isTerminal) {
        const match = text.substring(startPos, i + 1);
        const score = this.calculateScore(node.mergeRank!, node.frequency!);
        
        candidates.push({
          token: match,
          tokenId: node.tokenId!,
          mergeRank: node.mergeRank!,
          frequency: node.frequency!,
          score
        });
        
        // 更新最佳匹配（优先选择分数高的）
        if (score > this.calculateScore(bestMergeRank, bestFrequency) || bestMatch === '') {
          bestMatch = match;
          bestTokenId = node.tokenId!;
          bestMergeRank = node.mergeRank!;
          bestFrequency = node.frequency!;
        }
      }
    }
    
    if (bestMatch === '') {
      return null;
    }
    
    // 创建 Trace 锚点
    const traceAnchor: TraceAnchor = {
      position: startPos,
      decisionType: candidates.length > 1 ? 'merge' : 'split',
      candidates,
      selectedCandidate: bestMatch,
      reason: this.generateReason(bestMatch, candidates),
      timestamp: Date.now()
    };
    
    return {
      match: bestMatch,
      tokenId: bestTokenId,
      mergeRank: bestMergeRank,
      frequency: bestFrequency,
      traceAnchor
    };
  }

  /**
   * 计算候选分数
   */
  private calculateScore(mergeRank: number, frequency: number): number {
    // 分数 = 频率权重 * 0.7 + (1/rank) * 0.3
    const freqWeight = Math.log(frequency + 1) / 10;
    const rankWeight = 1 / (mergeRank + 1);
    return freqWeight * 0.7 + rankWeight * 0.3;
  }

  /**
   * 生成决策原因
   */
  private generateReason(selected: string, candidates: CandidateInfo[]): string {
    if (candidates.length === 1) {
      return `唯一匹配: ${selected}`;
    }
    
    const selectedCandidate = candidates.find(c => c.token === selected)!;
    const others = candidates.filter(c => c.token !== selected);
    
    if (selectedCandidate.score > Math.max(...others.map(c => c.score))) {
      return `分数最高 (${selectedCandidate.score.toFixed(3)})`;
    }
    
    if (selected.length > Math.max(...others.map(c => c.token.length))) {
      return `最长匹配 (${selected.length} 字符)`;
    }
    
    return `Rank 最低 (${selectedCandidate.mergeRank})`;
  }

  /**
   * 获取 Trie 树统计信息
   */
  getStats(): {
    vocabSize: number;
    nodeCount: number;
    maxDepth: number;
  } {
    let nodeCount = 0;
    let maxDepth = 0;
    
    const traverse = (node: TrieNode, depth: number) => {
      nodeCount++;
      maxDepth = Math.max(maxDepth, depth);
      
      for (const child of node.children.values()) {
        traverse(child, depth + 1);
      }
    };
    
    traverse(this.root, 0);
    
    return {
      vocabSize: this.vocabSize,
      nodeCount,
      maxDepth
    };
  }
}

/**
 * 逻辑瀑布流生成器
 */
export class LogicWaterfallGenerator {
  private trie: EnhancedTrie;
  
  constructor(trie: EnhancedTrie) {
    this.trie = trie;
  }

  /**
   * 生成完整的逻辑瀑布流
   */
  generate(text: string): LogicWaterfall {
    const startTime = Date.now();
    const stages: WaterfallStage[] = [];
    
    // Stage 1: Bytes
    const bytesStage = this.generateBytesStage(text);
    stages.push(bytesStage);
    
    // Stage 2: Characters
    const charsStage = this.generateCharactersStage(text);
    stages.push(charsStage);
    
    // Stage 3: Subwords (BPE 合并过程)
    const subwordsStage = this.generateSubwordsStage(text);
    stages.push(subwordsStage);
    
    // Stage 4: Full Words (最终结果)
    const fullwordsStage = this.generateFullwordsStage(text);
    stages.push(fullwordsStage);
    
    return {
      input: text,
      stages,
      totalTime: Date.now() - startTime
    };
  }

  /**
   * 生成字节阶段
   */
  private generateBytesStage(text: string): WaterfallStage {
    const tokens: PathToken[] = [];
    const bytes = new TextEncoder().encode(text);
    
    for (let i = 0; i < bytes.length; i++) {
      tokens.push({
        token: `[0x${bytes[i].toString(16).padStart(2, '0')}]`,
        tokenId: bytes[i],
        byteLength: 1
      });
    }
    
    return {
      level: 'bytes',
      tokens,
      processingTime: 0,
      mergeOperations: []
    };
  }

  /**
   * 生成字符阶段
   */
  private generateCharactersStage(text: string): WaterfallStage {
    const tokens: PathToken[] = [];
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const byteLength = new TextEncoder().encode(char).length;
      
      tokens.push({
        token: char,
        tokenId: char.charCodeAt(0),
        byteLength
      });
    }
    
    return {
      level: 'characters',
      tokens,
      processingTime: 0,
      mergeOperations: []
    };
  }

  /**
   * 生成子词阶段（BPE 合并过程）
   */
  private generateSubwordsStage(text: string): WaterfallStage {
    const tokens: PathToken[] = [];
    const mergeOperations: MergeOperation[] = [];
    let pos = 0;
    const stageStartTime = Date.now();
    
    while (pos < text.length) {
      const match = this.trie.findLongestMatch(text, pos);
      
      if (match) {
        const byteLength = new TextEncoder().encode(match.match).length;
        
        tokens.push({
          token: match.match,
          tokenId: match.tokenId,
          byteLength,
          mergeRank: match.mergeRank,
          frequency: match.frequency,
          decisionPoint: match.traceAnchor
        });
        
        // 记录合并操作
        if (match.traceAnchor.decisionType === 'merge' && match.traceAnchor.candidates.length > 1) {
          const candidates = match.traceAnchor.candidates;
          if (candidates.length >= 2) {
            mergeOperations.push({
              left: candidates[0].token,
              right: candidates[1].token,
              merged: match.match,
              rank: match.mergeRank,
              reason: match.traceAnchor.reason,
              timestamp: match.traceAnchor.timestamp
            });
          }
        }
        
        pos += match.match.length;
      } else {
        // Fallback: 使用单个字符
        const char = text[pos];
        const byteLength = new TextEncoder().encode(char).length;
        
        tokens.push({
          token: char,
          tokenId: char.charCodeAt(0),
          byteLength,
          decisionPoint: {
            position: pos,
            decisionType: 'fallback',
            candidates: [],
            selectedCandidate: char,
            reason: '未找到匹配，使用字符回退',
            timestamp: Date.now()
          }
        });
        
        pos++;
      }
    }
    
    return {
      level: 'subwords',
      tokens,
      processingTime: Date.now() - stageStartTime,
      mergeOperations
    };
  }

  /**
   * 生成完整词阶段（最终分词结果）
   */
  private generateFullwordsStage(text: string): WaterfallStage {
    // 与 subwords 阶段相同，但这是最终结果
    const subwordsStage = this.generateSubwordsStage(text);
    return {
      ...subwordsStage,
      level: 'fullwords'
    };
  }
}
