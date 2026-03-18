/**
 * 文本处理服务
 *
 * 参考 MiroFish 的 text_processor.py
 * 实现文本提取、分块、预处理功能
 */

import fs from 'fs';
import path from 'path';
import { parseDocument } from '../document-parser';

/**
 * 文本处理器
 */
export class TextProcessor {
  /**
   * 从多个文件提取文本
   */
  static async extractFromFiles(filePaths: string[]): Promise<string[]> {
    const results: string[] = [];

    for (const filePath of filePaths) {
      try {
        const text = await this.extractFromFile(filePath);
        if (text) {
          results.push(text);
        }
      } catch (error) {
        console.error(`[TextProcessor] 提取文件失败 ${filePath}:`, error);
      }
    }

    return results;
  }

  /**
   * 从单个文件提取文本
   */
  static async extractFromFile(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case '.pdf':
        return extractTextFromPDF(filePath);
      case '.docx':
      case '.doc':
        return extractTextFromDOCX(filePath);
      case '.md':
      case '.markdown':
        return extractTextFromMarkdown(filePath);
      case '.txt':
      case '.text':
        return extractTextFromTXT(filePath);
      default:
        // 尝试作为纯文本读取
        return extractTextFromTXT(filePath);
    }
  }

  /**
   * 分割文本为块
   */
  static splitText(
    text: string,
    chunkSize: number = 500,
    overlap: number = 50
  ): string[] {
    const chunks: string[] = [];
    const textLength = text.length;

    // 按段落分割
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();

      // 如果当前块加上新段落超过目标大小
      if (currentChunk.length + trimmedParagraph.length > chunkSize && currentChunk.length > 0) {
        // 保存当前块
        chunks.push(currentChunk.trim());

        // 开始新块，带重叠
        const overlapText = this.getOverlapText(currentChunk, overlap);
        currentChunk = overlapText + (overlapText ? '\n\n' : '') + trimmedParagraph;
      } else {
        // 继续累积
        currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
      }
    }

    // 保存最后一个块
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * 获取重叠文本
   */
  private static getOverlapText(text: string, overlapSize: number): string {
    if (text.length <= overlapSize) return text;

    // 从末尾取，尽量在句子边界切
    const candidate = text.substring(text.length - overlapSize);
    const lastPeriod = Math.max(
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('！'),
      candidate.lastIndexOf('？'),
      candidate.lastIndexOf('.'),
      candidate.lastIndexOf('!'),
      candidate.lastIndexOf('?')
    );

    return lastPeriod > overlapSize * 0.5
      ? text.substring(text.length - overlapSize + lastPeriod + 1)
      : candidate;
  }

  /**
   * 预处理文本
   */
  static preprocessText(text: string): string {
    // 标准化换行
    let processed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 移除连续空行（保留最多两个换行）
    processed = processed.replace(/\n{3,}/g, '\n\n');

    // 移除行首行尾空白
    const lines = processed.split('\n');
    processed = lines.map(line => line.trim()).join('\n');

    return processed.trim();
  }

  /**
   * 获取文本统计信息
   */
  static getTextStats(text: string): {
    totalChars: number;
    totalLines: number;
    totalWords: number;
  } {
    return {
      totalChars: text.length,
      totalLines: text.split('\n').length,
      totalWords: text.split(/\s+/).filter(w => w.length > 0).length,
    };
  }

  /**
   * 合并多个文本
   */
  static combineTexts(texts: string[], separator: string = '\n\n---\n\n'): string {
    return texts.filter(t => t.trim().length > 0).join(separator);
  }
}

/**
 * 文档解析器
 *
 * 提供从不同格式文档中提取文本的功能
 */
export class DocumentParser {
  /**
   * 从文件提取文本
   */
  static async extractFromFile(filePath: string): Promise<string> {
    try {
      const buffer = fs.readFileSync(filePath);
      const result = await parseDocument(buffer, filePath);
      return result.content;
    } catch (error) {
      console.error(`[DocumentParser] 文件解析失败: ${filePath}`, error);
      return '';
    }
  }
}
