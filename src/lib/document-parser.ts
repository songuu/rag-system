/**
 * 文档解析器 - 支持多种文件格式
 * 支持: TXT, PDF, Markdown, Excel, Word
 */

import * as XLSX from 'xlsx';

// 支持的文件类型
export const SUPPORTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.docx',
  '.doc',
  '.json',
] as const;

export type SupportedExtension = typeof SUPPORTED_EXTENSIONS[number];

export interface ParsedDocument {
  content: string;
  metadata: {
    filename: string;
    extension: string;
    size: number;
    pages?: number;
    sheets?: string[];
    parseMethod: string;
  };
}

export interface ParseResult {
  success: boolean;
  document?: ParsedDocument;
  error?: string;
}

/**
 * 检查文件扩展名是否支持
 */
export function isSupportedFile(filename: string): boolean {
  const ext = getFileExtension(filename);
  return SUPPORTED_EXTENSIONS.includes(ext as SupportedExtension);
}

/**
 * 获取文件扩展名（小写）
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.slice(lastDot).toLowerCase();
}

/**
 * 获取支持的文件类型描述
 */
export function getSupportedTypesDescription(): string {
  return '支持 TXT, Markdown, PDF, Excel, CSV, Word, JSON 文件';
}

/**
 * 解析文本文件
 */
async function parseTextFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  try {
    const content = buffer.toString('utf-8');
    return {
      success: true,
      document: {
        content,
        metadata: {
          filename,
          extension: getFileExtension(filename),
          size: buffer.length,
          parseMethod: 'text',
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `文本解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 Markdown 文件
 */
async function parseMarkdownFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  try {
    const content = buffer.toString('utf-8');
    // Markdown 保持原始格式，包含标记语法
    return {
      success: true,
      document: {
        content,
        metadata: {
          filename,
          extension: getFileExtension(filename),
          size: buffer.length,
          parseMethod: 'markdown',
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Markdown 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 PDF 文件
 */
async function parsePdfFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  console.log(`[PDF Parser] 开始解析: ${filename}, 大小: ${buffer.length} bytes`);
  
  try {
    // 动态导入 pdf-parse v2.x
    const { PDFParse } = await import('pdf-parse');
    console.log('[PDF Parser] pdf-parse 模块加载成功');
    
    // 使用 v2 API: 需要先创建 PDFParse 实例
    const parser = new PDFParse({ data: buffer });
    console.log('[PDF Parser] PDFParse 实例创建成功');
    
    // 获取文本内容
    const textResult = await parser.getText();
    console.log(`[PDF Parser] 文本提取成功, 长度: ${textResult.text.length}`);
    
    // 获取文档信息（页数等）
    const infoResult = await parser.getInfo();
    console.log(`[PDF Parser] 文档信息获取成功, 页数: ${infoResult.total}`);
    
    // 释放资源
    await parser.destroy();
    console.log('[PDF Parser] 资源已释放');
    
    return {
      success: true,
      document: {
        content: textResult.text,
        metadata: {
          filename,
          extension: '.pdf',
          size: buffer.length,
          pages: infoResult.total,
          parseMethod: 'pdf-parse-v2',
        },
      },
    };
  } catch (error) {
    console.error(`[PDF Parser] 解析失败:`, error);
    return {
      success: false,
      error: `PDF 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 Excel 文件 (xlsx, xls, csv)
 */
async function parseExcelFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets: string[] = workbook.SheetNames;
    
    // 将所有工作表内容合并
    const contents: string[] = [];
    
    for (const sheetName of sheets) {
      const worksheet = workbook.Sheets[sheetName];
      
      // 转换为 JSON 格式
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
      
      if (jsonData.length > 0) {
        contents.push(`## 工作表: ${sheetName}\n`);
        
        // 获取表头
        const headers = jsonData[0] as string[];
        
        // 构建表格内容
        for (let i = 0; i < jsonData.length; i++) {
          const row = jsonData[i] as unknown[];
          if (row.length === 0) continue;
          
          if (i === 0) {
            // 表头行
            contents.push(`| ${row.join(' | ')} |`);
            contents.push(`| ${row.map(() => '---').join(' | ')} |`);
          } else {
            // 数据行 - 确保每个单元格都有值
            const cells = headers.map((_, idx) => {
              const cell = row[idx];
              return cell !== undefined && cell !== null ? String(cell) : '';
            });
            contents.push(`| ${cells.join(' | ')} |`);
          }
        }
        contents.push('\n');
      }
    }
    
    return {
      success: true,
      document: {
        content: contents.join('\n'),
        metadata: {
          filename,
          extension: getFileExtension(filename),
          size: buffer.length,
          sheets,
          parseMethod: 'xlsx',
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Excel 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 Word 文件 (docx)
 */
async function parseWordFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  try {
    // 动态导入 mammoth
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    
    return {
      success: true,
      document: {
        content: result.value,
        metadata: {
          filename,
          extension: getFileExtension(filename),
          size: buffer.length,
          parseMethod: 'mammoth',
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `Word 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 解析 JSON 文件
 */
async function parseJsonFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  try {
    const content = buffer.toString('utf-8');
    // 验证 JSON 格式
    const parsed = JSON.parse(content);
    // 格式化输出
    const formattedContent = JSON.stringify(parsed, null, 2);
    
    return {
      success: true,
      document: {
        content: formattedContent,
        metadata: {
          filename,
          extension: '.json',
          size: buffer.length,
          parseMethod: 'json',
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 主解析函数 - 根据文件类型自动选择解析器
 */
export async function parseDocument(buffer: Buffer, filename: string): Promise<ParseResult> {
  const ext = getFileExtension(filename);
  
  if (!isSupportedFile(filename)) {
    return {
      success: false,
      error: `不支持的文件类型: ${ext}。${getSupportedTypesDescription()}`,
    };
  }
  
  switch (ext) {
    case '.txt':
      return parseTextFile(buffer, filename);
    
    case '.md':
    case '.markdown':
      return parseMarkdownFile(buffer, filename);
    
    case '.pdf':
      return parsePdfFile(buffer, filename);
    
    case '.xlsx':
    case '.xls':
    case '.csv':
      return parseExcelFile(buffer, filename);
    
    case '.docx':
    case '.doc':
      return parseWordFile(buffer, filename);
    
    case '.json':
      return parseJsonFile(buffer, filename);
    
    default:
      return {
        success: false,
        error: `未知的文件类型: ${ext}`,
      };
  }
}

/**
 * 批量解析文档
 */
export async function parseDocuments(
  files: Array<{ buffer: Buffer; filename: string }>
): Promise<ParseResult[]> {
  return Promise.all(
    files.map(({ buffer, filename }) => parseDocument(buffer, filename))
  );
}

/**
 * 获取文件图标（用于前端显示）
 */
export function getFileIcon(filename: string): string {
  const ext = getFileExtension(filename);
  switch (ext) {
    case '.pdf':
      return 'fa-file-pdf';
    case '.xlsx':
    case '.xls':
    case '.csv':
      return 'fa-file-excel';
    case '.docx':
    case '.doc':
      return 'fa-file-word';
    case '.md':
    case '.markdown':
      return 'fa-file-code';
    case '.json':
      return 'fa-file-code';
    case '.txt':
    default:
      return 'fa-file-alt';
  }
}

/**
 * 获取文件类型颜色（用于前端显示）
 */
export function getFileColor(filename: string): string {
  const ext = getFileExtension(filename);
  switch (ext) {
    case '.pdf':
      return 'text-red-500';
    case '.xlsx':
    case '.xls':
    case '.csv':
      return 'text-green-500';
    case '.docx':
    case '.doc':
      return 'text-blue-500';
    case '.md':
    case '.markdown':
      return 'text-purple-500';
    case '.json':
      return 'text-yellow-500';
    case '.txt':
    default:
      return 'text-gray-500';
  }
}
