/**
 * 本体生成服务
 *
 * 参考 MiroFish 的 ontology_generator.py
 * 分析文本内容，生成适合社会舆论模拟的实体和关系类型定义
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLLMFromOverride } from './model-override';
import {
  ONTOLOGY_CONSTANTS,
  type Ontology,
  type EntityTypeDefinition,
  type EdgeTypeDefinition,
  type OntologyGenerateRequest,
  type ModelOverride,
} from './types';

// 本体生成的系统提示词
const ONTOLOGY_SYSTEM_PROMPT = `你是一个专业的知识图谱本体设计专家。你的任务是分析给定的文本内容和模拟需求，设计适合**社交媒体舆论模拟**的实体和关系类型定义。

**重要：你必须输出有效的JSON格式数据，不要输出任何其他内容。**

## 核心任务背景

我们正在构建一个**社交媒体舆论模拟系统**。在这个系统中：
- 每个实体都是一个可以在社交媒体上发声、互动、传播信息的"账号"或"主体"
- 实体之间会相互影响、转发、评论、回应
- 我们需要模拟舆论事件中各方的反应和信息传播路径

因此，**实体必须是现实中真实存在的、可以在社媒上发声和互动的主体**：

**可以是**：
- 具体的个人（公众人物、当事人、意见领袖、专家学者、普通人）
- 公司、企业（包括其官方账号）
- 组织机构（大学、协会、NGO、工会等）
- 政府部门、监管机构
- 媒体机构（报纸、电视台、自媒体、网站）
- 社交媒体平台本身
- 特定群体代表（如校友会、粉丝团、维权群体等）

**不可以是**：
- 抽象概念（如"舆论"、"情绪"、"趋势"）
- 主题/话题（如"学术诚信"、"教育改革"）
- 观点/态度（如"支持方"、"反对方"）

## 输出格式

请输出JSON格式，包含以下结构：

\`\`\`json
{
    "entity_types": [
        {
            "name": "实体类型名称（英文，PascalCase）",
            "description": "简短描述（英文，不超过100字符）",
            "attributes": [
                {
                    "name": "属性名（英文，snake_case）",
                    "type": "text",
                    "description": "属性描述"
                }
            ],
            "examples": ["示例实体1", "示例实体2"]
        }
    ],
    "edge_types": [
        {
            "name": "关系类型名称（英文，UPPER_SNAKE_CASE）",
            "description": "简短描述（英文，不超过100字符）",
            "source_targets": [
                {"source": "源实体类型", "target": "目标实体类型"}
            ],
            "attributes": []
        }
    ],
    "analysis_summary": "对文本内容的简要分析说明（中文）"
}
\`\`\`

## 设计指南（极其重要！）

### 1. 实体类型设计 - 必须严格遵守

**数量要求：必须正好10个实体类型**

**层次结构要求（必须同时包含具体类型和兜底类型）**：

你的10个实体类型必须包含以下层次：

A. **兜底类型（必须包含，放在列表最后2个）**：
   - \`Person\`: 任何自然人个体的兜底类型。当一个人不属于其他更具体的人物类型时，归入此类。
   - \`Organization\`: 任何组织机构的兜底类型。当一个组织不属于其他更具体的组织类型时，归入此类。

B. **具体类型（8个，根据文本内容设计）**：
   - 针对文本中出现的主要角色，设计更具体的类型
   - 例如：如果文本涉及学术事件，可以有 \`Student\`, \`Professor\`, \`University\`
   - 例如：如果文本涉及商业事件，可以有 \`Company\`, \`CEO\`, \`Employee\`

**为什么需要兜底类型**：
- 文本中会出现各种人物，如"中小学教师"、"路人甲"、"某位网友"
- 如果没有专门的类型匹配，他们应该被归入 \`Person\`
- 同理，小型组织、临时团体等应该归入 \`Organization\`

**具体类型的设计原则**：
- 从文本中识别出高频出现或关键的角色类型
- 每个具体类型应该有明确的边界，避免重叠
- description 必须清晰说明这个类型和兜底类型的区别

### 2. 关系类型设计

- 数量：6-10个
- 关系应该反映社媒互动中的真实联系
- 确保关系的 source_targets 涵盖你定义的实体类型

### 3. 属性设计

- 每个实体类型1-3个关键属性
- **注意**：属性名不能使用 \`name\`、\`uuid\`、\`group_id\`、\`created_at\`、\`summary\`（这些是系统保留字）
- 推荐使用：\`full_name\`、\`title\`、\`role\`、\`position\`、\`location\`、\`description\` 等

## 实体类型参考

**个人类（具体）**：
- Student: 学生
- Professor: 教授/学者
- Journalist: 记者
- Celebrity: 明星/网红
- Executive: 高管
- Official: 政府官员
- Lawyer: 律师
- Doctor: 医生

**个人类（兜底）**：
- Person: 任何自然人（不属于上述具体类型时使用）

**组织类（具体）**：
- University: 高校
- Company: 公司企业
- GovernmentAgency: 政府机构
- MediaOutlet: 媒体机构
- Hospital: 医院
- School: 中小学
- NGO: 非政府组织

**组织类（兜底）**：
- Organization: 任何组织机构（不属于上述具体类型时使用）

## 关系类型参考

- WORKS_FOR: 工作于
- STUDIES_AT: 就读于
- AFFILIATED_WITH: 隶属于
- REPRESENTS: 代表
- REGULATES: 监管
- REPORTS_ON: 报道
- COMMENTS_ON: 评论
- RESPONDS_TO: 回应
- SUPPORTS: 支持
- OPPOSES: 反对
- COLLABORATES_WITH: 合作
- COMPETES_WITH: 竞争`;

/**
 * 本体生成器
 *
 * 分析文本内容，生成实体和关系类型定义
 */
export class OntologyGenerator {
  private llm: BaseChatModel;

  constructor(modelOverride?: ModelOverride) {
    this.llm = createLLMFromOverride(modelOverride, { temperature: 0.3 });
  }

  /**
   * 生成本体定义
   */
  async generate(request: OntologyGenerateRequest): Promise<Ontology> {
    const { texts, simulationRequirement, additionalContext } = request;

    // 构建用户消息
    const userMessage = this.buildUserMessage(texts, simulationRequirement, additionalContext);

    const messages = [
      { role: 'system' as const, content: ONTOLOGY_SYSTEM_PROMPT },
      { role: 'user' as const, content: userMessage },
    ];

    // 调用 LLM
    const result = await this.llm.invoke(messages);

    // 解析 JSON
    const ontology = this.parseJsonResponse(result.content as string);

    // 验证和后处理
    return this.validateAndProcess(ontology);
  }

  /**
   * 构建用户消息
   */
  private buildUserMessage(
    texts: string[],
    simulationRequirement: string,
    additionalContext?: string
  ): string {
    // 合并文本
    let combinedText = texts.join('\n\n---\n\n');
    const originalLength = combinedText.length;

    // 如果文本超过限制，截断
    if (combinedText.length > ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH) {
      combinedText = combinedText.substring(0, ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH);
      combinedText += `\n\n...(原文共${originalLength}字，已截取前${ONTOLOGY_CONSTANTS.MAX_TEXT_LENGTH}字用于本体分析)...`;
    }

    let message = `## 模拟需求\n\n${simulationRequirement}\n\n## 文档内容\n\n${combinedText}`;

    if (additionalContext) {
      message += `\n\n## 额外说明\n\n${additionalContext}`;
    }

    message += `
请根据以上内容，设计适合社会舆论模拟的实体类型和关系类型。

**必须遵守的规则**：
1. 必须正好输出10个实体类型
2. 最后2个必须是兜底类型：Person（个人兜底）和 Organization（组织兜底）
3. 前8个是根据文本内容设计的具体类型
4. 所有实体类型必须是现实中可以发声的主体，不能是抽象概念
5. 属性名不能使用 name、uuid、group_id 等保留字，用 full_name、org_name 等替代
`;

    return message;
  }

  /**
   * 解析 LLM 返回的 JSON
   */
  private parseJsonResponse(response: string): Partial<Ontology> {
    // 移除代码块标记
    let cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // 尝试提取 JSON 对象
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('无法从响应中提取 JSON');
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      // 尝试修复常见的 JSON 问题
      cleaned = this.fixJsonIssues(jsonMatch[0]);
      try {
        return JSON.parse(cleaned);
      } catch {
        throw new Error('无法解析 JSON 响应');
      }
    }
  }

  /**
   * 修复常见 JSON 问题
   */
  private fixJsonIssues(jsonStr: string): string {
    let fixed = jsonStr;

    // 修复尾随逗号
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // 修复缺少逗号
    fixed = fixed.replace(/}(\s*){/g, '},$1{');
    fixed = fixed.replace(/](\s*)\[/g, '],$1[');

    // 修复属性名没有引号
    fixed = fixed.replace(/(\{|\,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // 修复中文冒号
    fixed = fixed.replace(/：/g, ':');

    return fixed;
  }

  /**
   * 验证和后处理结果
   */
  private validateAndProcess(result: Partial<Ontology>): Ontology {
    // 确保必要字段存在
    const entityTypes: EntityTypeDefinition[] = Array.isArray(result.entity_types)
      ? result.entity_types
      : [];
    const edgeTypes: EdgeTypeDefinition[] = Array.isArray(result.edge_types)
      ? result.edge_types
      : [];

    // 验证实体类型
    for (const entity of entityTypes) {
      if (!entity.attributes) {
        entity.attributes = [];
      }
      if (!entity.examples) {
        entity.examples = [];
      }
      // 确保 description 不超过 100 字符
      if (entity.description && entity.description.length > 100) {
        entity.description = entity.description.substring(0, 97) + '...';
      }
    }

    // 验证关系类型
    for (const edge of edgeTypes) {
      if (!edge.source_targets) {
        edge.source_targets = [];
      }
      if (!edge.attributes) {
        edge.attributes = [];
      }
      if (edge.description && edge.description.length > 100) {
        edge.description = edge.description.substring(0, 97) + '...';
      }
    }

    // 检查并添加兜底类型
    const entityNames = new Set(entityTypes.map(e => e.name));
    const hasPerson = entityNames.has('Person');
    const hasOrganization = entityNames.has('Organization');

    const fallbacks: EntityTypeDefinition[] = [];

    if (!hasPerson) {
      fallbacks.push({
        ...ONTOLOGY_CONSTANTS.FALLBACK_ENTITY_TYPES.Person,
      } as EntityTypeDefinition);
    }

    if (!hasOrganization) {
      fallbacks.push({
        ...ONTOLOGY_CONSTANTS.FALLBACK_ENTITY_TYPES.Organization,
      } as EntityTypeDefinition);
    }

    // 如果需要添加兜底类型
    if (fallbacks.length > 0) {
      const currentCount = entityTypes.length;
      const neededSlots = fallbacks.length;

      // 如果添加后会超过 10 个，需要移除一些现有类型
      if (currentCount + neededSlots > ONTOLOGY_CONSTANTS.MAX_ENTITY_TYPES) {
        const toRemove = currentCount + neededSlots - ONTOLOGY_CONSTANTS.MAX_ENTITY_TYPES;
        entityTypes.splice(entityTypes.length - toRemove, toRemove);
      }

      // 添加兜底类型
      entityTypes.push(...fallbacks);
    }

    // 最终确保不超过限制
    const finalEntityTypes = entityTypes.slice(0, ONTOLOGY_CONSTANTS.MAX_ENTITY_TYPES);
    const finalEdgeTypes = edgeTypes.slice(0, ONTOLOGY_CONSTANTS.MAX_EDGE_TYPES);

    return {
      entity_types: finalEntityTypes,
      edge_types: finalEdgeTypes,
      analysis_summary: result.analysis_summary || '',
    };
  }

  /**
   * 将本体定义转换为 Python 代码
   */
  generatePythonCode(ontology: Ontology): string {
    const lines: string[] = [
      '"""',
      '自定义实体类型定义',
      '由MiroFish自动生成，用于社会舆论模拟',
      '"""',
      '',
      'from pydantic import Field',
      'from zep_cloud.external_clients.ontology import EntityModel, EntityText, EdgeModel',
      '',
      '',
      '# ============== 实体类型定义 ==============',
      '',
    ];

    // 生成实体类型
    for (const entity of ontology.entity_types) {
      lines.push(`class ${entity.name}(EntityModel):`);
      lines.push(`    """${entity.description}"""`);

      if (entity.attributes.length > 0) {
        for (const attr of entity.attributes) {
          lines.push(`    ${attr.name}: EntityText = Field(`);
          lines.push(`        description="${attr.description}",`);
          lines.push(`        default=None`);
          lines.push(`    )`);
        }
      } else {
        lines.push('    pass');
      }

      lines.push('');
      lines.push('');
    }

    lines.push('# ============== 关系类型定义 ==============');
    lines.push('');

    // 生成关系类型
    for (const edge of ontology.edge_types) {
      // 转换为 PascalCase 类名
      const className = edge.name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

      lines.push(`class ${className}(EdgeModel):`);
      lines.push(`    """${edge.description}"""`);

      if (edge.attributes.length > 0) {
        for (const attr of edge.attributes) {
          lines.push(`    ${attr.name}: EntityText = Field(`);
          lines.push(`        description="${attr.description}",`);
          lines.push(`        default=None`);
          lines.push(`    )`);
        }
      } else {
        lines.push('    pass');
      }

      lines.push('');
      lines.push('');
    }

    // 生成类型字典
    lines.push('# ============== 类型配置 ==============');
    lines.push('');
    lines.push('ENTITY_TYPES = {');
    for (const entity of ontology.entity_types) {
      lines.push(`    "${entity.name}": ${entity.name},`);
    }
    lines.push('}');
    lines.push('');
    lines.push('EDGE_TYPES = {');
    for (const edge of ontology.edge_types) {
      const className = edge.name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
      lines.push(`    "${edge.name}": ${className},`);
    }
    lines.push('}');
    lines.push('');

    return lines.join('\n');
  }
}
