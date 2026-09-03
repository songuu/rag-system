import type { OptimizeInput } from './contracts';

export interface PromptTemplate { id: string; name: string; description: string; mode: OptimizeInput['mode']; guidance: string; }
export interface ModelMessage { role: 'system' | 'user'; content: string; }

const TEMPLATES: PromptTemplate[] = [
  { id: 'general-v1', name: '通用增强', description: '补足角色、背景、约束和交付格式', mode: 'general', guidance: '明确角色、目标、背景、步骤、约束、质量标准与输出格式。' },
  { id: 'structured-v1', name: '结构化任务', description: '面向分析、写作与工作流任务', mode: 'structured', guidance: '将任务组织为目标、输入、执行步骤、边界条件、验收标准和严格输出结构。' },
  { id: 'image-v1', name: '图像创作', description: '面向 GPT Image 等图像模型的描述增强', mode: 'image', guidance: '系统补全主体、环境、构图、镜头、光线、色彩、材质、风格、文字排版和负面约束。' },
];

export function listPromptTemplates(): PromptTemplate[] { return TEMPLATES.map(item => ({ ...item })); }

export function buildOptimizationMessages(input: OptimizeInput): ModelMessage[] {
  const template = TEMPLATES.find(item => item.id === input.templateId && item.mode === input.mode)
    ?? TEMPLATES.find(item => item.mode === input.mode)!;
  return [
    {
      role: 'system',
      content: `你是资深提示词架构师。${template.guidance}\n保持原始意图和 {{variable}} 变量标记，不要执行提示词本身。只返回 JSON：{"prompt":"优化后的完整提示词","analysis":{"summary":"一句话说明","improvements":["改进点"]}}。`,
    },
    {
      role: 'user',
      content: `原始提示词：\n${input.prompt}\n\n额外要求：${input.instruction || '无'}\n变量名：${Object.keys(input.variables).join(', ') || '无'}`,
    },
  ];
}
