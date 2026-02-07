/**
 * 检索关联映射器（Retrieval Alignment Mapper）
 * 
 * 当查询进入向量库并返回 Document Chunks 时，
 * 该模块对 Query Token 和 Chunk Token 进行交叉比对
 */

import type {
  TokenDecisionMetadata,
  RetrievalContribution,
  RetrievalPathGraph,
  TokenSimilarityEntry
} from './types';

export interface ChunkAnalysis {
  chunkId: string;
  content: string;
  tokens: Array<{
    token: string;
    tokenId: number;
    position: number;
  }>;
  overallSimilarity: number;
  embedding?: number[];
}

export class RetrievalAlignmentMapper {
  /**
   * 计算检索贡献度
   * 公式: Contribution = cos_sim(token_vec, query_vec) * ||token_vec||
   */
  calculateRetrievalContributions(
    queryTokens: TokenDecisionMetadata[],
    queryEmbedding: number[],
    tokenEmbeddings?: number[][]
  ): RetrievalContribution[] {
    const queryNorm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0));
    
    return queryTokens.map((token, index) => {
      // 如果有 token 级别的嵌入，使用它
      let tokenEmbedding = tokenEmbeddings?.[index];
      
      // 如果没有，基于 token 特征估算
      if (!tokenEmbedding) {
        tokenEmbedding = this.estimateTokenEmbedding(token, queryEmbedding);
      }

      const tokenNorm = Math.sqrt(tokenEmbedding.reduce((sum, v) => sum + v * v, 0));
      
      // 计算余弦相似度
      const dotProduct = tokenEmbedding.reduce((sum, v, i) => sum + v * queryEmbedding[i], 0);
      const cosineSimilarity = dotProduct / (tokenNorm * queryNorm + 1e-8);
      
      // 计算贡献度
      const contribution = cosineSimilarity * tokenNorm;

      return {
        tokenId: token.tokenId,
        contribution,
        normalizedContribution: 0, // 后续归一化
        cosineSimilarity,
        vectorNorm: tokenNorm,
        isKeyToken: false // 后续判断
      };
    });
  }

  /**
   * 归一化贡献度并标记关键 Token
   */
  normalizeAndMarkKeyTokens(contributions: RetrievalContribution[]): RetrievalContribution[] {
    const totalContribution = contributions.reduce((sum, c) => sum + Math.abs(c.contribution), 0);
    const avgContribution = totalContribution / contributions.length;
    
    return contributions.map(c => ({
      ...c,
      normalizedContribution: totalContribution > 0 ? c.contribution / totalContribution : 0,
      isKeyToken: c.contribution > avgContribution * 1.5
    }));
  }

  /**
   * 构建检索路径图
   */
  buildRetrievalPathGraph(
    queryId: string,
    queryTokens: TokenDecisionMetadata[],
    queryEmbedding: number[],
    retrievedChunks: ChunkAnalysis[]
  ): RetrievalPathGraph {
    // 计算 Query Token 的贡献度
    let contributions = this.calculateRetrievalContributions(queryTokens, queryEmbedding);
    contributions = this.normalizeAndMarkKeyTokens(contributions);

    // 构建 Query Tokens 信息
    const queryTokensInfo = queryTokens.map((token, index) => ({
      token: token.token,
      tokenId: token.tokenId,
      contribution: contributions[index]
    }));

    // 构建相似度矩阵
    const similarityMatrix = this.buildSimilarityMatrix(queryTokens, retrievedChunks);

    // 识别关键匹配路径
    const keyMatchPaths = this.identifyKeyMatchPaths(similarityMatrix, contributions);

    return {
      queryId,
      queryTokens: queryTokensInfo,
      retrievedChunks: retrievedChunks.map(chunk => ({
        chunkId: chunk.chunkId,
        content: chunk.content,
        tokens: chunk.tokens,
        overallSimilarity: chunk.overallSimilarity
      })),
      similarityMatrix,
      keyMatchPaths
    };
  }

  /**
   * 构建 Token 级相似度矩阵
   */
  buildSimilarityMatrix(
    queryTokens: TokenDecisionMetadata[],
    retrievedChunks: ChunkAnalysis[]
  ): TokenSimilarityEntry[] {
    const matrix: TokenSimilarityEntry[] = [];

    queryTokens.forEach((queryToken, queryIndex) => {
      retrievedChunks.forEach((chunk, chunkIndex) => {
        chunk.tokens.forEach((chunkToken, chunkTokenIndex) => {
          // 计算 token 级相似度
          const similarity = this.calculateTokenSimilarity(queryToken, chunkToken);
          
          if (similarity > 0.3) { // 只记录有意义的相似度
            matrix.push({
              queryTokenIndex: queryIndex,
              queryToken: queryToken.token,
              chunkTokenIndex: chunkIndex * 1000 + chunkTokenIndex, // 复合索引
              chunkToken: chunkToken.token,
              similarity,
              isStrongMatch: similarity > 0.7
            });
          }
        });
      });
    });

    // 按相似度排序
    matrix.sort((a, b) => b.similarity - a.similarity);

    return matrix.slice(0, 100); // 只保留前100个
  }

  /**
   * 计算两个 token 的相似度
   */
  private calculateTokenSimilarity(
    queryToken: TokenDecisionMetadata,
    chunkToken: { token: string; tokenId: number }
  ): number {
    const q = queryToken.token.toLowerCase().replace(/^##|^▁/g, '');
    const c = chunkToken.token.toLowerCase().replace(/^##|^▁/g, '');

    // 精确匹配
    if (q === c) return 1.0;

    // 包含关系
    if (q.includes(c) || c.includes(q)) {
      return 0.8 * Math.min(q.length, c.length) / Math.max(q.length, c.length);
    }

    // 编辑距离相似度
    const editDistance = this.calculateEditDistance(q, c);
    const maxLen = Math.max(q.length, c.length);
    const editSimilarity = 1 - editDistance / maxLen;

    // Token ID 相似度（同一词汇表中的 ID 越接近可能越相似）
    const idDiff = Math.abs(queryToken.tokenId - chunkToken.tokenId);
    const idSimilarity = 1 / (1 + idDiff * 0.001);

    // 综合相似度
    return editSimilarity * 0.7 + idSimilarity * 0.3;
  }

  /**
   * 计算编辑距离
   */
  private calculateEditDistance(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + 1
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * 识别关键匹配路径
   */
  private identifyKeyMatchPaths(
    similarityMatrix: TokenSimilarityEntry[],
    contributions: RetrievalContribution[]
  ): RetrievalPathGraph['keyMatchPaths'] {
    const keyTokenIndices = new Set(
      contributions
        .filter(c => c.isKeyToken)
        .map((_, i) => i)
    );

    // 找出关键 token 的强匹配
    const keyMatches = similarityMatrix
      .filter(entry => 
        keyTokenIndices.has(entry.queryTokenIndex) && 
        entry.isStrongMatch
      )
      .slice(0, 20);

    return keyMatches.map(match => ({
      queryTokenIndex: match.queryTokenIndex,
      chunkIndex: Math.floor(match.chunkTokenIndex / 1000),
      chunkTokenIndex: match.chunkTokenIndex % 1000,
      matchScore: match.similarity
    }));
  }

  /**
   * 估算 token 嵌入（当没有实际嵌入时使用）
   */
  private estimateTokenEmbedding(
    token: TokenDecisionMetadata,
    queryEmbedding: number[]
  ): number[] {
    // 基于 token 特征创建伪嵌入
    const dim = queryEmbedding.length;
    const embedding = new Array(dim).fill(0);

    // 使用 token ID 和特征生成确定性的伪嵌入
    const seed = token.tokenId;
    for (let i = 0; i < dim; i++) {
      // 简单的伪随机生成
      const val = Math.sin(seed * (i + 1) * 0.01) * 0.5;
      embedding[i] = val * (1 + token.semanticEntropy.frequency);
    }

    // 与 query embedding 部分对齐
    const alignmentFactor = token.confidence * 0.3;
    for (let i = 0; i < dim; i++) {
      embedding[i] = embedding[i] * (1 - alignmentFactor) + queryEmbedding[i] * alignmentFactor;
    }

    return embedding;
  }

  /**
   * 分析检索质量
   */
  analyzeRetrievalQuality(pathGraph: RetrievalPathGraph): {
    qualityScore: number;
    keyTokenCoverage: number;
    avgMatchStrength: number;
    issues: string[];
  } {
    const issues: string[] = [];

    // 关键 Token 覆盖率
    const keyTokens = pathGraph.queryTokens.filter(t => t.contribution.isKeyToken);
    const coveredKeyTokens = new Set(
      pathGraph.keyMatchPaths.map(p => p.queryTokenIndex)
    );
    const keyTokenCoverage = keyTokens.length > 0 
      ? coveredKeyTokens.size / keyTokens.length 
      : 1;

    if (keyTokenCoverage < 0.5) {
      issues.push('关键词元覆盖率低，可能影响检索准确性');
    }

    // 平均匹配强度
    const avgMatchStrength = pathGraph.keyMatchPaths.length > 0
      ? pathGraph.keyMatchPaths.reduce((sum, p) => sum + p.matchScore, 0) / pathGraph.keyMatchPaths.length
      : 0;

    if (avgMatchStrength < 0.6) {
      issues.push('平均匹配强度较弱，检索结果可能不够精准');
    }

    // 综合质量得分
    const qualityScore = keyTokenCoverage * 0.5 + avgMatchStrength * 0.5;

    return {
      qualityScore,
      keyTokenCoverage,
      avgMatchStrength,
      issues
    };
  }
}
