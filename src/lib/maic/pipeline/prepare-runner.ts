/**
 * 课程准备 Runner
 *
 * 编排 Read/Plan 流水线,以发布-订阅方式推送 SSE 事件。
 * 每个 courseId 只允许一个正在运行的 runner (竞态防护)。
 */

import { createLLM } from '../../model-config';
import { getMaicStore } from '../course-store';
import type { Course, PrepareEvent, CoursePrepared, SlidePage } from '../types';
import {
  getMaicPrepareCacheIdentity,
  loadPreparedFromCache,
  savePreparedToCache,
} from '../prepare-cache';
import { describePages, buildKnowledgeTree } from './read-stage';
import { generateLectureScript, generateActiveQuestions, buildCourseStage } from './plan-stage';

type Listener = (event: PrepareEvent) => void;

interface PrepareJob {
  course_id: string;
  listeners: Set<Listener>;
  events: PrepareEvent[];
  finished: boolean;
}

class PrepareRunner {
  private jobs: Map<string, PrepareJob> = new Map();
  private starting: Set<string> = new Set();

  subscribe(courseId: string, listener: Listener): () => void {
    const job = this.jobs.get(courseId);
    if (job) {
      for (const e of job.events) listener(e);
      job.listeners.add(listener);
    }
    return () => {
      const j = this.jobs.get(courseId);
      j?.listeners.delete(listener);
    };
  }

  isRunning(courseId: string): boolean {
    const job = this.jobs.get(courseId);
    return !!job && !job.finished;
  }

  async start(courseId: string): Promise<void> {
    if (this.starting.has(courseId)) return;
    const existing = this.jobs.get(courseId);
    if (existing && !existing.finished) return;

    this.starting.add(courseId);

    const job: PrepareJob = {
      course_id: courseId,
      listeners: new Set(),
      events: [],
      finished: false,
    };
    this.jobs.set(courseId, job);

    const emit = (event: PrepareEvent) => {
      job.events.push(event);
      for (const l of job.listeners) {
        try {
          l(event);
        } catch {
          /* ignore listener error */
        }
      }
    };

    try {
      this.starting.delete(courseId);
      await this.runPipeline(courseId, emit);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      getMaicStore().updateCourseStatus(courseId, 'failed', message);
      emit({ type: 'prepare:error', data: { error: message } });
    } finally {
      job.finished = true;
    }
  }

  private async runPipeline(courseId: string, emit: (e: PrepareEvent) => void): Promise<void> {
    const store = getMaicStore();
    const course = store.getCourse(courseId);
    if (!course) throw new Error(`课程不存在: ${courseId}`);
    if (course.status === 'ready' && course.prepared) {
      emit({
        type: 'prepare:done',
        data: { course_id: courseId, message: '课程已就绪', progress: 1 },
      });
      return;
    }

    store.updateCourseStatus(courseId, 'preparing');
    emit({ type: 'prepare:start', data: { course_id: courseId, message: '开始准备课程' } });

    const cacheIdentity = getMaicPrepareCacheIdentity({
      sourceText: course.source_text,
      pages: course.source_pages,
    });
    emit({
      type: 'prepare:cache',
      data: { message: '检查课程准备缓存' },
    });

    const cached = await loadPreparedFromCache(cacheIdentity);
    if (cached) {
      store.setCoursePrepared(courseId, cached.prepared);
      emit({
        type: 'prepare:cache',
        data: {
          message: '命中课程缓存,跳过 LLM 准备阶段',
          cache_status: 'hit',
          progress: 1,
        },
      });
      emit({
        type: 'prepare:done',
        data: { course_id: courseId, message: '课程准备完成', progress: 1 },
      });
      return;
    }

    emit({
      type: 'prepare:cache',
      data: { message: '未命中缓存,开始完整准备流程', cache_status: 'miss' },
    });

    // 1. 上传阶段已解析出结构化页时直接复用,避免 prepare 阶段二次切页漂移。
    let pagesRaw = getRawPagesForCourse(course);
    // 若 course.source_text 已是整篇文本但没有明显分页,按段落再切一次。
    if (pagesRaw.length <= 1 && course.source_text) {
      const chunks = course.source_text.split(/\n{2,}/).filter(s => s.trim().length >= 20);
      const merged: SlidePage[] = [];
      let buf = '';
      for (const c of chunks) {
        buf += (buf ? '\n\n' : '') + c.trim();
        if (buf.length >= 500) {
          merged.push({ index: merged.length, raw_text: buf, description: '', key_points: [] });
          buf = '';
        }
      }
      if (buf.trim().length >= 20)
        merged.push({ index: merged.length, raw_text: buf, description: '', key_points: [] });
      if (merged.length > 0) pagesRaw = merged;
    }

    if (pagesRaw.length === 0) {
      throw new Error('课程原始文本为空或无法切页');
    }

    emit({
      type: 'prepare:read_raw',
      data: { total_pages: pagesRaw.length, message: `共 ${pagesRaw.length} 页` },
    });

    const llm = createLLM(undefined, { temperature: 0.3 });

    // 2. Describe
    const described = await describePages(llm, pagesRaw, idx => {
      emit({
        type: 'prepare:describe',
        data: {
          page_index: idx,
          total_pages: pagesRaw.length,
          progress: (idx + 1) / pagesRaw.length,
        },
      });
    });

    // 3. Knowledge tree
    emit({ type: 'prepare:tree', data: { message: '正在构建知识树' } });
    const tree = await buildKnowledgeTree(llm, described);

    // 4. Lecture script
    const script = await generateLectureScript(llm, described, idx => {
      emit({
        type: 'prepare:script',
        data: {
          page_index: idx,
          total_pages: described.length,
          progress: (idx + 1) / described.length,
        },
      });
    });

    // 5. Active questions
    emit({ type: 'prepare:questions', data: { message: '生成课堂主动提问' } });
    const questions = await generateActiveQuestions(llm, tree);
    emit({ type: 'prepare:scenes', data: { message: '生成 OpenMAIC 场景与动作' } });
    const { stage, scenes } = buildCourseStage(described, tree, questions);

    const prepared: CoursePrepared = {
      pages: described,
      knowledge_tree: tree,
      lecture_script: script,
      active_questions: questions,
      stage,
      scenes,
    };
    store.setCoursePrepared(courseId, prepared);
    const stored = await savePreparedToCache(cacheIdentity, prepared);
    if (stored) {
      emit({
        type: 'prepare:cache',
        data: { message: '课程准备结果已写入缓存', cache_status: 'stored' },
      });
    }

    emit({
      type: 'prepare:done',
      data: { course_id: courseId, message: '课程准备完成', progress: 1 },
    });
  }
}

let instance: PrepareRunner | null = null;

export function getPrepareRunner(): PrepareRunner {
  if (!instance) instance = new PrepareRunner();
  return instance;
}

export type { PrepareRunner };

function getRawPagesForCourse(course: Course): SlidePage[] {
  if (course.source_pages?.length) {
    return course.source_pages.map((page, index) => ({
      index,
      raw_text: page.raw_text.trim(),
      description: '',
      key_points: [],
    }));
  }

  if (!course.source_text) return [];

  return course.source_text
    .split(/\n(?=#{1,3}\s)/)
    .map((text, index) => ({
      index,
      raw_text: text.trim(),
      description: '',
      key_points: [],
    }))
    .filter(page => page.raw_text.length > 0);
}
