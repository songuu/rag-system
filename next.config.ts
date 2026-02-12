/*
 * @Author: songuu 1101309860@qq.com
 * @Date: 2026-01-09 13:47:40
 * @LastEditors: songuu 1101309860@qq.com
 * @LastEditTime: 2026-02-07 10:52:34
 * @FilePath: \project\rag-nextjs\next.config.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import type { NextConfig } from "next";

const isStaticExport = process.env.STATIC_EXPORT === 'true';

const nextConfig: NextConfig = {
  /* config options here */
  ...(isStaticExport ? {
    output: 'export',      // GitHub Pages 静态导出
    images: {
      unoptimized: true,   // GitHub Pages 不支持 Next.js 默认的图片优化
    },
    basePath: '/rag-system',
  } : {
  images: {
      unoptimized: true,
    },
  }),

  env: {
    NEXT_PUBLIC_BASE_PATH: isStaticExport ? '/rag-system' : '',
  },

  // 忽略构建时的 TypeScript 错误（部分 API 路由类型在 Next.js 16 中有变化）
  typescript: {
    ignoreBuildErrors: true,
  },
  
  // 排除某些原生模块，确保 pdf-parse 正常工作
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist', 'canvas'],
  
  // Turbopack 配置（Next.js 16+ 默认使用 Turbopack）
  turbopack: {},
};

export default nextConfig;
