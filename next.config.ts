/*
 * @Author: songuu 1101309860@qq.com
 * @Date: 2026-01-09 13:47:40
 * @LastEditors: songuu 1101309860@qq.com
 * @LastEditTime: 2026-02-07 10:52:34
 * @FilePath: \project\rag-nextjs\next.config.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: 'export',      // 必须：开启静态导出
  images: {
    unoptimized: true,   // 必须：GitHub Pages 不支持 Next.js 默认的图片优化
  },

  basePath: '/ai-rag',
  
  // 排除某些原生模块，确保 pdf-parse 正常工作
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist', 'canvas'],
  
  // Turbopack 配置（Next.js 16+ 默认使用 Turbopack）
  turbopack: {},
};

export default nextConfig;
