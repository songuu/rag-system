/**
 * 报告生成 Agent
 *
 * 分析模拟数据，生成结构化预测报告
 */

import { createLLM } from '../model-config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  ReportInfo,
  ReportSection,
  SimulationPost,
  SimulationInfo,
  TimelineEntry,
} from './types';

const REPORT_SYSTEM_PROMPT = `你是一个专业的社会舆论分析师。你的任务是根据社交媒体模拟数据，生成一份结构化的分析报告。

报告需要包含以下章节：

1. **总体概述** (overview) - 模拟场景、参与者、规模概述
2. **情感分析** (sentiment) - 情感趋势变化、各方立场
3. **阵营与联盟** (coalition) - 意见群体形成、极化趋势
4. **时间线分析** (timeline) - 关键时刻、转折点、话题演变
5. **预测与推断** (prediction) - 基于模拟数据的趋势预测
6. **总结与建议** (conclusion) - 核心发现、建议

**你必须输出有效的JSON格式。**

输出格式:
\`\`\`json
{
  "title": "报告标题",
  "summary": "200字以内的摘要",
  "sections": [
    {
      "index": 0,
      "title": "章节标题",
      "content": "章节内容（Markdown格式）",
      "type": "overview|sentiment|coalition|timeline|prediction|conclusion"
    }
  ],
  "key_findings": ["发现1", "发现2", "发现3"]
}
\`\`\``;

export class ReportAgent {
  private llm: BaseChatModel;

  constructor() {
    this.llm = createLLM(undefined, { temperature: 0.3 });
  }

  /** 生成完整报告 */
  async generateReport(
    simulationInfo: SimulationInfo,
    posts: SimulationPost[],
    timeline: TimelineEntry[]
  ): Promise<Omit<ReportInfo, 'report_id' | 'created_at' | 'updated_at'>> {
    const dataContext = this.buildDataContext(simulationInfo, posts, timeline);

    const response = await this.llm.invoke([
      { role: 'system', content: REPORT_SYSTEM_PROMPT },
      { role: 'user', content: dataContext },
    ]);

    const reportData = this.parseReportResponse(response.content as string);

    // 计算情感趋势
    const sentimentTrend = timeline.map(entry => ({
      round: entry.round,
      positive: entry.stats.sentiment_distribution.positive,
      neutral: entry.stats.sentiment_distribution.neutral,
      negative: entry.stats.sentiment_distribution.negative,
    }));

    const title = String(reportData.title || '模拟分析报告');
    const summary = String(reportData.summary || '');
    const rawSections = Array.isArray(reportData.sections) ? reportData.sections : [];
    const rawFindings = Array.isArray(reportData.key_findings) ? reportData.key_findings : [];

    return {
      simulation_id: simulationInfo.simulation_id,
      project_id: simulationInfo.project_id,
      status: 'completed' as const,
      title,
      summary,
      sections: rawSections.map((s: Record<string, unknown>, i: number) => ({
        index: i,
        title: String(s.title || ''),
        content: String(s.content || ''),
        type: this.validateSectionType(String(s.type || 'overview')),
      })),
      key_findings: rawFindings.map(String),
      sentiment_trend: sentimentTrend,
      generated_at: new Date().toISOString(),
    };
  }

  /** 与报告对话 */
  async chat(
    reportInfo: ReportInfo,
    question: string,
    history: Array<{ role: string; content: string }>
  ): Promise<string> {
    const systemPrompt = `你是分析这份报告的AI助手。报告内容如下：

标题: ${reportInfo.title}
摘要: ${reportInfo.summary}

${reportInfo.sections.map(s => `## ${s.title}\n${s.content}`).join('\n\n')}

关键发现:
${reportInfo.key_findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}

请根据报告内容回答用户的问题。如果问题超出报告范围，请说明并给出合理推断。`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user' as const, content: question },
    ];

    const response = await this.llm.invoke(messages);
    return response.content as string;
  }

  /** 构建数据上下文 */
  private buildDataContext(
    info: SimulationInfo,
    posts: SimulationPost[],
    timeline: TimelineEntry[]
  ): string {
    // 统计数据
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    const authorStats = new Map<string, { posts: number; sentiment: string[] }>();
    const topicCounts: Record<string, number> = {};

    for (const post of posts) {
      sentimentCounts[post.sentiment] += 1;

      if (!authorStats.has(post.author_name)) {
        authorStats.set(post.author_name, { posts: 0, sentiment: [] });
      }
      const stats = authorStats.get(post.author_name)!;
      stats.posts += 1;
      stats.sentiment.push(post.sentiment);

      for (const topic of post.topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }

    // 热门话题
    const hotTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // 采样帖子
    const samplePosts = posts
      .filter(p => ['post', 'quote', 'comment'].includes(p.action))
      .slice(-30)
      .map(p => `[${p.platform}] ${p.author_name}(${p.sentiment}): ${p.content.substring(0, 100)}`)
      .join('\n');

    return `## 模拟数据概览

模拟场景: ${info.config.seed_topics.join(', ')}
平台: ${info.config.platforms.join(', ')}
总轮次: ${info.current_round}
参与Agent数: ${info.agent_profiles.length}
总帖子数: ${posts.length}

## 情感分布
正面: ${sentimentCounts.positive} (${posts.length > 0 ? Math.round(sentimentCounts.positive / posts.length * 100) : 0}%)
中性: ${sentimentCounts.neutral} (${posts.length > 0 ? Math.round(sentimentCounts.neutral / posts.length * 100) : 0}%)
负面: ${sentimentCounts.negative} (${posts.length > 0 ? Math.round(sentimentCounts.negative / posts.length * 100) : 0}%)

## 热门话题
${hotTopics.map(([topic, count]) => `- ${topic}: ${count}次`).join('\n')}

## 参与者统计
${Array.from(authorStats.entries()).map(([name, stats]) => {
  const mainSentiment = stats.sentiment.reduce((acc, s) => {
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const dominant = Object.entries(mainSentiment).sort((a, b) => b[1] - a[1])[0];
  return `- ${name}: ${stats.posts}条, 倾向${dominant?.[0] || 'neutral'}`;
}).join('\n')}

## 采样帖子
${samplePosts}

## 时间线变化
${timeline.map(t =>
  `第${t.round}轮: ${t.stats.total_posts}条, 正面${t.stats.sentiment_distribution.positive} 中性${t.stats.sentiment_distribution.neutral} 负面${t.stats.sentiment_distribution.negative}, 话题:${t.stats.hot_topics.join(',')}`
).join('\n')}

请根据以上数据生成完整的分析报告。`;
  }

  /** 解析报告响应 */
  private parseReportResponse(response: string): Record<string, unknown> {
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return {
        title: '模拟分析报告',
        summary: response.substring(0, 200),
        sections: [{
          index: 0,
          title: '分析内容',
          content: response,
          type: 'overview',
        }],
        key_findings: [],
      };
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return {
        title: '模拟分析报告',
        summary: '报告解析失败，请查看原始内容。',
        sections: [{
          index: 0,
          title: '原始分析',
          content: response,
          type: 'overview',
        }],
        key_findings: [],
      };
    }
  }

  /** 验证章节类型 */
  private validateSectionType(type: string): ReportSection['type'] {
    const valid: ReportSection['type'][] = [
      'overview', 'sentiment', 'coalition', 'timeline', 'prediction', 'conclusion',
    ];
    return valid.includes(type as ReportSection['type'])
      ? (type as ReportSection['type'])
      : 'overview';
  }
}

let reportAgentInstance: ReportAgent | null = null;

export function getReportAgent(): ReportAgent {
  if (!reportAgentInstance) {
    reportAgentInstance = new ReportAgent();
  }
  return reportAgentInstance;
}
