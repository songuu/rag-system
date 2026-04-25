---
title: "MAIC 初始化缓存与 RAG 融合"
date: 2026-04-25
tags: [solution, maic, cache, rag]
related_instincts: [maic-prepared-artifact-cache]
aliases: ["MAIC prepare cache", "MAIC RAG bridge"]
---

# MAIC 初始化缓存与 RAG 融合

## Problem

MAIC 课程初始化每次都重新调用 LLM 生成页描述、知识树、讲稿和课堂问题；同一份课件重复上传或准备时仍然很慢。同时 MAIC 上传只写入内存课程 store，没有进入现有 RAG 的 `uploads/*_parsed.txt` 文档入口。

## Root Cause

准备产物没有课程级 artifact cache，缓存 key 也没有把源内容、页边界和模型配置绑定起来。上传阶段解析出的结构化页没有被保留，prepare 阶段又从纯文本重新切页，导致数据链路既慢又容易漂移。

## Solution

新增 `src/lib/maic/prepare-cache.ts`，用课程文本/页边界 hash + LLM 配置 + 缓存版本生成 prepared cache key，缓存完整 `CoursePrepared`。上传和 prepare runner 都会先查缓存，命中后直接 `setCoursePrepared()` 并跳过 LLM 准备阶段。

新增 `src/lib/maic/rag-bridge.ts`，把 MAIC 解析文本镜像为 `uploads/maic_<hash>_<name>_parsed.txt` 并写入 `file-manifest.json`，让现有 RAG reinitialize/sync 路径能消费 MAIC 课程资料。

## Prevention

以后新增跨系统资料入口时，先确认项目已有的 canonical corpus 目录或 manifest，不要让功能模块只写私有内存 store。对 LLM 生成型准备产物，缓存 key 必须包含源内容、结构边界、模型配置和 prompt/cache 版本。

## Related

- [[maic-prepared-artifact-cache]] — LLM 准备产物优先做课程级 artifact cache
- [[session-2026-04-25]] — MAIC 初始化缓存 sprint
