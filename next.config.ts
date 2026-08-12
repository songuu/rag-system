/*
 * @Author: songuu 1101309860@qq.com
 * @Date: 2026-01-09 13:47:40
 * @LastEditors: songuu 1101309860@qq.com
 * @LastEditTime: 2026-02-07 10:52:34
 * @FilePath: \project\rag-nextjs\next.config.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import type { NextConfig } from "next";

const rawStandaloneSourceExtensions = [
  'js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx', 'cts', 'mts',
] as const;

function excludeRawStandaloneSources(...directories: string[]): string[] {
  return directories.flatMap(directory => rawStandaloneSourceExtensions.map(
    extension => `${directory}/**/*.${extension}`
  ));
}

const isStaticExport = process.env.STATIC_EXPORT === 'true';
const configuredRagBasePath = process.env.RAG_BASE_PATH?.replace(/\/+$/, '');
const ragBasePath = configuredRagBasePath || (isStaticExport ? '/rag-system' : '');

if (ragBasePath && (!ragBasePath.startsWith('/') || ragBasePath === '/')) {
  throw new Error('RAG_BASE_PATH must be a non-root absolute path.');
}

const nextConfig: NextConfig = {
  /* config options here */
  ...(isStaticExport ? {
    output: 'export',      // GitHub Pages 静态导出
    images: {
      unoptimized: true,   // GitHub Pages 不支持 Next.js 默认的图片优化
    },
    basePath: ragBasePath,
  } : {
    output: 'standalone',  // 容器部署使用 Next.js standalone server 产物
    images: {
      unoptimized: true,
    },
  }),

  // The songuu.top root is a gateway. Deploying RAG below /rag-system keeps
  // its Next assets and routes separate from the other hosted applications.
  ...(!isStaticExport && ragBasePath ? { basePath: ragBasePath } : {}),

  env: {
    NEXT_PUBLIC_BASE_PATH: ragBasePath,
  },

  // Local development still uses the historical /api routes. Production
  // requests go through the host's isolated /rag-api prefix instead.
  ...(!isStaticExport && !ragBasePath ? {
    async rewrites() {
      return [{ source: '/rag-api/:path*', destination: '/api/:path*' }];
    },
  } : {}),

  // 排除某些原生模块，确保 pdf-parse 正常工作
  serverExternalPackages: ['pdf-parse', '@llamaindex/liteparse', '@napi-rs/canvas', 'pdfjs-dist', 'canvas'],

  // File-backed runtime stores use dynamic paths. Next's file tracer can
  // conservatively collect the stores' neighboring source and test files as
  // assets even though the compiled route chunks already contain the code.
  // Keep these route-scoped and extension-scoped so real runtime assets and
  // external mounted store roots remain available.
  outputFileTracingExcludes: {
    '/api/ask': excludeRawStandaloneSources(
      'src/lib/rag/core',
      'src/lib/rag/multimodal',
      'src/lib/mirofish'
    ),
    '/api/pipeline': excludeRawStandaloneSources(
      'src/lib/rag/multimodal'
    ),
    '/api/mirofish/graph': excludeRawStandaloneSources(
      'src/lib/mirofish'
    ),
  },
  
  // Turbopack 配置（Next.js 16+ 默认使用 Turbopack）
  turbopack: {},
};

export default nextConfig;
