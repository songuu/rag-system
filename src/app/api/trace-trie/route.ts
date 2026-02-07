import { NextRequest, NextResponse } from 'next/server';
import { EnhancedTrie, LogicWaterfallGenerator } from '@/lib/trace-trie';
import { 
  VectorWeightAnalyzer, 
  TokenDensityAnalyzer, 
  ModelComparisonAnalyzer 
} from '@/lib/token-analyzer';
import { AutoTokenizer } from '@xenova/transformers';

/**
 * 从 tokenizer 中提取词汇表
 * @xenova/transformers 的 tokenizer 没有 get_vocab() 方法
 * 需要从内部结构中提取
 */
function extractVocabulary(tokenizer: any): Map<string, number> {
  const vocab = new Map<string, number>();
  
  // 辅助函数：从对象或Map中提取词汇
  const extractFromVocabObject = (vocabObj: any) => {
    if (!vocabObj) return;
    
    if (vocabObj instanceof Map) {
      vocabObj.forEach((value: any, key: any) => {
        // 处理两种可能的映射方向
        if (typeof key === 'string' && typeof value === 'number') {
          vocab.set(key, value);
        } else if (typeof value === 'string' && typeof key === 'number') {
          vocab.set(value, key);
        }
      });
    } else if (Array.isArray(vocabObj)) {
      // 某些模型的词汇表是数组格式
      vocabObj.forEach((token, index) => {
        if (typeof token === 'string') {
          vocab.set(token, index);
        } else if (token && typeof token.content === 'string') {
          vocab.set(token.content, token.id || index);
        }
      });
    } else if (typeof vocabObj === 'object') {
      Object.entries(vocabObj).forEach(([key, value]) => {
        if (typeof value === 'number') {
          vocab.set(key, value);
        } else if (typeof value === 'string' && !isNaN(parseInt(key))) {
          vocab.set(value, parseInt(key));
        }
      });
    }
  };

  // 尝试多种路径获取词汇表
  const vocabPaths = [
    // 1. WordPiece/BERT 模型路径
    () => tokenizer.model?.vocab,
    () => tokenizer.model?.config?.vocab,
    
    // 2. BPE 模型路径
    () => tokenizer.model?.encoder,
    () => tokenizer.model?.bpe?.vocab,
    
    // 3. 直接访问路径
    () => tokenizer.vocab,
    () => tokenizer.encoder,
    
    // 4. 内部 tokenizer 路径
    () => tokenizer.tokenizer_?.model?.vocab,
    () => tokenizer.tokenizer_?.vocab,
    
    // 5. 配置中的词汇表
    () => tokenizer.config?.vocab,
    
    // 6. 特殊的嵌套路径
    () => tokenizer._tokenizer?.model?.vocab
  ];

  for (const getVocab of vocabPaths) {
    try {
      const vocabObj = getVocab();
      if (vocabObj) {
        extractFromVocabObject(vocabObj);
        if (vocab.size > 0) {
          console.log(`[Trace-Trie] Found vocabulary via path, size: ${vocab.size}`);
          break;
        }
      }
    } catch {
      // 忽略访问错误，继续尝试下一个路径
    }
  }
  
  // 添加 added_tokens（特殊 token）
  if (tokenizer.added_tokens) {
    try {
      tokenizer.added_tokens.forEach((tokenInfo: any) => {
        if (tokenInfo && tokenInfo.content && typeof tokenInfo.id === 'number') {
          vocab.set(tokenInfo.content, tokenInfo.id);
        }
      });
    } catch {
      // 忽略错误
    }
  }

  // 添加 special_tokens
  if (tokenizer.special_tokens) {
    try {
      Object.entries(tokenizer.special_tokens).forEach(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
          const tokenObj = value as { content?: string; id?: number };
          if (tokenObj.content && typeof tokenObj.id === 'number') {
            vocab.set(tokenObj.content, tokenObj.id);
          }
        }
      });
    } catch {
      // 忽略错误
    }
  }
  
  return vocab;
}

/**
 * POST /api/trace-trie
 * 分析文本的 Trace-Trie 分词过程
 */
export async function POST(request: NextRequest) {
  try {
    const { text, modelNames = ['Xenova/bert-base-multilingual-cased'] } = await request.json();

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid text input' },
        { status: 400 }
      );
    }

    // 1. 构建增强型 Trie 树
    const trie = new EnhancedTrie();
    
    // 加载第一个模型的词汇表来构建 Trie
    const primaryModel = modelNames[0];
    const tokenizer = await AutoTokenizer.from_pretrained(primaryModel);
    
    // 使用兼容的方式获取词汇表
    const vocab = extractVocabulary(tokenizer);
    
    console.log(`[Trace-Trie] Extracted vocabulary size: ${vocab.size}`);
    
    // 如果词汇表为空，使用 encode/decode 方式构建简化版词汇表
    if (vocab.size === 0) {
      console.log('[Trace-Trie] Vocabulary extraction failed, using tokenization-based approach');
      
      try {
        // 对输入文本进行分词，直接使用 tokenizer 的结果
        const encoded = tokenizer.encode(text, { add_special_tokens: false });
        
        // 尝试使用 batch_decode 来获取每个 token 的文本表示
        let decodedTokens: string[] = [];
        
        try {
          // 方法1: batch_decode
          decodedTokens = tokenizer.batch_decode(
            encoded.map((id: number) => [id]), 
            { skip_special_tokens: false }
          );
        } catch {
          // 方法2: 逐个 decode
          try {
            decodedTokens = encoded.map((id: number) => tokenizer.decode([id]));
          } catch {
            // 方法3: 使用 convert_ids_to_tokens（如果可用）
            if (typeof tokenizer.convert_ids_to_tokens === 'function') {
              decodedTokens = tokenizer.convert_ids_to_tokens(encoded);
            }
          }
        }
        
        // 构建基于当前文本的词汇表
        for (let i = 0; i < encoded.length; i++) {
          const token = decodedTokens[i] || `[TOKEN:${encoded[i]}]`;
          vocab.set(token.trim(), encoded[i]);
        }
        
        console.log(`[Trace-Trie] Built vocabulary from tokenization, size: ${vocab.size}`);
      } catch (err) {
        console.error('[Trace-Trie] Failed to build vocabulary from tokenization:', err);
      }
    }
    
    // 构建词汇表元数据（简化版：使用 tokenId 作为 rank 和 frequency 的代理）
    const vocabMap = new Map<string, { id: number; rank: number; frequency: number }>();
    vocab.forEach((id, token) => {
      const tokenId = id as number;
      // 估算 rank 和 frequency（实际应该从模型训练数据中获取）
      const rank = tokenId < 100 ? 0 : tokenId < 1000 ? 100 : tokenId;
      const frequency = tokenId < 100 ? 10000 : tokenId < 1000 ? 1000 : 100;
      vocabMap.set(token, { id: tokenId, rank, frequency });
    });
    
    trie.buildFromVocabulary(vocabMap);

    // 2. 生成逻辑瀑布流
    const waterfallGenerator = new LogicWaterfallGenerator(trie);
    const waterfall = waterfallGenerator.generate(text);

    // 3. 分析向量权重
    const vectorAnalyzer = new VectorWeightAnalyzer(primaryModel);
    await vectorAnalyzer.initialize();
    
    // 获取最终阶段的 tokens
    const finalTokens = waterfall.stages[waterfall.stages.length - 1].tokens.map(t => ({
      token: t.token,
      tokenId: t.tokenId
    }));
    
    const vectorWeights = await vectorAnalyzer.analyzeVectorWeights(finalTokens);

    // 4. 分析词元密度
    const densityAnalyzer = new TokenDensityAnalyzer();
    const densityInfos = densityAnalyzer.analyzeDensity(finalTokens);

    // 5. 多模型对比（如果提供了多个模型）
    let modelComparisons = [];
    if (modelNames.length > 1) {
      const comparisonAnalyzer = new ModelComparisonAnalyzer();
      modelComparisons = await comparisonAnalyzer.compareModels(text, modelNames);
    }

    return NextResponse.json({
      success: true,
      data: {
        waterfall,
        vectorWeights,
        densityInfos,
        modelComparisons,
        trieStats: trie.getStats()
      }
    });

  } catch (error) {
    console.error('[Trace-Trie API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
