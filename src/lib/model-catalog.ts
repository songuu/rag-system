export type ModelCategory = 'reasoning' | 'llm' | 'embedding' | 'unknown';

export interface RecommendedModel {
  name: string;
  displayName: string;
  description: string;
  size?: string;
  contextLength?: number;
  dimension?: number;
  supportsThinking?: boolean;
  thinkingControl?: string;
  recommended: boolean;
}

export interface OpenMaicLatestModelNote {
  provider: string;
  model: string;
  displayName: string;
  category: 'llm' | 'reasoning' | 'image' | 'audio' | 'search' | 'video';
  supportsThinking?: boolean;
  thinkingControl?: string;
  status: 'supported' | 'documented';
}

interface ModelCategoryConfig {
  patterns: string[];
  include?: string[];
  exclude?: string[];
}

export const OPENMAIC_LATEST_MODEL_NOTES: OpenMaicLatestModelNote[] = [
  {
    provider: 'openai',
    model: 'gpt-5.5',
    displayName: 'GPT-5.5',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'reasoning_effort',
    status: 'supported',
  },
  {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'reasoning.effort',
    status: 'supported',
  },
  {
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'reasoning.effort',
    status: 'supported',
  },
  {
    provider: 'lemonade',
    model: 'Gemma-4-26B-A4B-it-GGUF',
    displayName: 'Gemma 4 26B A4B IT GGUF',
    category: 'reasoning',
    status: 'supported',
  },
  {
    provider: 'google',
    model: 'gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.level',
    status: 'supported',
  },
  {
    provider: 'tencent-hunyuan',
    model: 'hy3-preview',
    displayName: 'Tencent Hy3 Preview',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'chat_template_kwargs.reasoning_effort',
    status: 'documented',
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    displayName: 'Xiaomi MiMo V2.5 Pro',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.type',
    status: 'supported',
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2-pro',
    displayName: 'Xiaomi MiMo V2 Pro',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.type',
    status: 'supported',
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    displayName: 'Xiaomi MiMo V2.5',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.type',
    status: 'supported',
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2-omni',
    displayName: 'Xiaomi MiMo V2 Omni',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.type',
    status: 'supported',
  },
  {
    provider: 'xiaomi',
    model: 'mimo-v2-flash',
    displayName: 'Xiaomi MiMo V2 Flash',
    category: 'reasoning',
    supportsThinking: true,
    thinkingControl: 'thinking.type',
    status: 'supported',
  },
  {
    provider: 'openai',
    model: 'gpt-image-2',
    displayName: 'GPT-Image-2',
    category: 'image',
    status: 'documented',
  },
  {
    provider: 'bocha',
    model: 'web-search',
    displayName: 'Bocha Web Search',
    category: 'search',
    status: 'documented',
  },
  {
    provider: 'happyhorse',
    model: 'video-adapter',
    displayName: 'HappyHorse Video Adapter',
    category: 'video',
    status: 'documented',
  },
  {
    provider: 'azure',
    model: 'azure-asr-fast-transcription',
    displayName: 'Azure STT Fast Transcription',
    category: 'audio',
    status: 'documented',
  },
];

export const MODEL_CATEGORIES: Record<Exclude<ModelCategory, 'unknown'>, ModelCategoryConfig> = {
  reasoning: {
    patterns: [
      'deepseek-r1',
      'deepseek-v4',
      'qwen3',
      'qwen3.5',
      'qwen3.6',
      'o1',
      'o3',
      'gpt-5',
      'gpt-oss',
      'claude-haiku-4-5',
      'reasoning',
      'hy3',
      'mimo',
      'kimi-k2-thinking',
    ],
    include: ['deepseek-r1', 'deepseek-v4', 'qwen3', 'gpt-oss'],
    exclude: ['embedding'],
  },
  llm: {
    patterns: [
      'llama',
      'mistral',
      'mixtral',
      'gemma',
      'phi',
      'qwen',
      'deepseek',
      'yi',
      'solar',
      'vicuna',
      'orca',
      'starling',
      'openchat',
      'neural',
      'dolphin',
      'wizard',
      'falcon',
      'glm',
      'kimi',
      'gpt',
      'claude',
      'grok',
      'hunyuan',
      'mimo',
    ],
    exclude: ['embed', 'embedding', 'deepseek-r1', 'deepseek-v4', 'qwen3', 'gpt-oss'],
  },
  embedding: {
    patterns: ['embed', 'embedding', 'bge', 'gte', 'jina', 'e5', 'instructor', 'multilingual-e5'],
    include: ['nomic-embed', 'mxbai-embed', 'snowflake-arctic-embed'],
  },
};

export const RECOMMENDED_MODELS: {
  reasoning: RecommendedModel[];
  llm: RecommendedModel[];
  embedding: RecommendedModel[];
} = {
  reasoning: [
    {
      name: 'deepseek-r1:7b',
      displayName: 'DeepSeek R1 7B',
      description: '深度推理模型，支持思维链 (Chain of Thought)',
      size: '4.7 GB',
      contextLength: 32768,
      supportsThinking: true,
      thinkingControl: 'native',
      recommended: true,
    },
    {
      name: 'deepseek-r1:14b',
      displayName: 'DeepSeek R1 14B',
      description: '更强大的深度推理模型',
      size: '8.9 GB',
      contextLength: 32768,
      supportsThinking: true,
      thinkingControl: 'native',
      recommended: true,
    },
    {
      name: 'deepseek-r1:32b',
      displayName: 'DeepSeek R1 32B',
      description: '顶级深度推理模型，最强推理能力',
      size: '19 GB',
      contextLength: 65536,
      supportsThinking: true,
      thinkingControl: 'native',
      recommended: false,
    },
    {
      name: 'qwen3:8b',
      displayName: 'Qwen 3 8B',
      description: '阿里通义千问第三代，支持推理',
      size: '4.9 GB',
      contextLength: 32768,
      supportsThinking: true,
      thinkingControl: 'thinking_budget',
      recommended: true,
    },
    {
      name: 'qwen3:14b',
      displayName: 'Qwen 3 14B',
      description: '更强大的通义千问推理版',
      size: '9.0 GB',
      contextLength: 32768,
      supportsThinking: true,
      thinkingControl: 'thinking_budget',
      recommended: false,
    },
    {
      name: 'gpt-oss:20b',
      displayName: 'GPT-OSS 20B',
      description: 'OpenMAIC Lemonade 默认支持的本地推理模型族',
      size: 'local',
      supportsThinking: true,
      thinkingControl: 'chat_template_kwargs.enable_thinking',
      recommended: false,
    },
  ],
  llm: [
    {
      name: 'llama3.1:latest',
      displayName: 'Llama 3.1',
      description: 'Meta Llama 模型，性能稳定',
      size: '4.7 GB',
      contextLength: 128000,
      recommended: true,
    },
    {
      name: 'llama3.2:latest',
      displayName: 'Llama 3.2',
      description: 'Meta 轻量版本，更快更准确',
      size: '2.0 GB',
      contextLength: 128000,
      recommended: true,
    },
    {
      name: 'qwen2.5:latest',
      displayName: 'Qwen 2.5',
      description: '阿里通义千问，中文优化',
      size: '4.4 GB',
      contextLength: 32768,
      recommended: true,
    },
    {
      name: 'mistral:latest',
      displayName: 'Mistral',
      description: '高性能开源模型',
      size: '4.1 GB',
      contextLength: 32768,
      recommended: false,
    },
    {
      name: 'gemma2:latest',
      displayName: 'Gemma 2',
      description: 'Google 轻量级模型',
      size: '5.4 GB',
      contextLength: 8192,
      recommended: false,
    },
  ],
  embedding: [
    {
      name: 'nomic-embed-text:latest',
      displayName: 'Nomic Embed Text',
      description: '高质量英文嵌入模型',
      dimension: 768,
      size: '274 MB',
      recommended: true,
    },
    {
      name: 'mxbai-embed-large:latest',
      displayName: 'MixedBread AI Embed',
      description: '大型嵌入模型，性能优异',
      dimension: 1024,
      size: '669 MB',
      recommended: true,
    },
    {
      name: 'bge-large:latest',
      displayName: 'BGE Large',
      description: 'BAAI 出品，中英文支持',
      dimension: 1024,
      size: '1.3 GB',
      recommended: false,
    },
    {
      name: 'snowflake-arctic-embed:latest',
      displayName: 'Snowflake Arctic Embed',
      description: '多语言嵌入模型',
      dimension: 1024,
      size: '669 MB',
      recommended: false,
    },
  ],
};

export function categorizeModelName(modelName: string): ModelCategory {
  const nameLower = modelName.toLowerCase();

  if (
    MODEL_CATEGORIES.reasoning.include?.some(
      pattern => nameLower.includes(pattern) && !nameLower.includes('embedding')
    )
  ) {
    return 'reasoning';
  }

  if (
    MODEL_CATEGORIES.reasoning.patterns.some(
      pattern => nameLower.includes(pattern) && !nameLower.includes('embedding')
    )
  ) {
    return 'reasoning';
  }

  if (MODEL_CATEGORIES.embedding.include?.some(pattern => nameLower.includes(pattern))) {
    return 'embedding';
  }

  if (MODEL_CATEGORIES.embedding.patterns.some(pattern => nameLower.includes(pattern))) {
    return 'embedding';
  }

  if (MODEL_CATEGORIES.llm.exclude?.some(pattern => nameLower.includes(pattern))) {
    return 'unknown';
  }

  if (MODEL_CATEGORIES.llm.patterns.some(pattern => nameLower.includes(pattern))) {
    return 'llm';
  }

  return 'unknown';
}

export function getModelCapabilityProfile(
  provider: string,
  modelName: string,
  category: ModelCategory = categorizeModelName(modelName)
): {
  supportsThinking: boolean;
  thinkingControl?: string;
  openMaicLatest: boolean;
} {
  const providerLower = provider.toLowerCase();
  const modelLower = modelName.toLowerCase();
  const latest = OPENMAIC_LATEST_MODEL_NOTES.find(
    item => item.provider === providerLower && item.model.toLowerCase() === modelLower
  );

  if (latest) {
    return {
      supportsThinking: !!latest.supportsThinking,
      thinkingControl: latest.thinkingControl,
      openMaicLatest: true,
    };
  }

  if (providerLower === 'lemonade') {
    return {
      supportsThinking: true,
      thinkingControl: 'chat_template_kwargs.enable_thinking',
      openMaicLatest: false,
    };
  }

  if (providerLower === 'openrouter' && modelLower.includes('deepseek-v4')) {
    return {
      supportsThinking: true,
      thinkingControl: 'reasoning.effort',
      openMaicLatest: false,
    };
  }

  if (modelLower.includes('gpt-5')) {
    return {
      supportsThinking: true,
      thinkingControl: 'reasoning_effort',
      openMaicLatest: false,
    };
  }

  if (modelLower.includes('qwen3')) {
    return {
      supportsThinking: true,
      thinkingControl: 'thinking_budget',
      openMaicLatest: false,
    };
  }

  return {
    supportsThinking: category === 'reasoning',
    openMaicLatest: false,
  };
}
