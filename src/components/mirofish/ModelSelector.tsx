'use client';

import React, { useState } from 'react';
import type { ModelOverride } from '@/lib/mirofish/types';

interface ModelSelectorProps {
  value: ModelOverride | null;
  onChange: (override: ModelOverride | null) => void;
  onSave: (override: ModelOverride | null) => Promise<void>;
}

const PROVIDER_LABELS: Record<ModelOverride['provider'], string> = {
  ollama: 'Ollama (本地)',
  openai: 'OpenAI',
  custom: 'Custom (OpenAI 兼容)',
};

const DEFAULT_MODELS: Record<ModelOverride['provider'], string> = {
  ollama: 'llama3.1',
  openai: 'gpt-4o-mini',
  custom: 'deepseek-chat',
};

const DEFAULT_BASE_URLS: Record<ModelOverride['provider'], string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com/v1',
  custom: '',
};

export default function ModelSelector({ value, onChange, onSave }: ModelSelectorProps) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 本地编辑态（避免每次改动都触发 onChange）
  const [draft, setDraft] = useState<ModelOverride>(() =>
    value || {
      provider: 'ollama',
      modelName: DEFAULT_MODELS.ollama,
      baseUrl: DEFAULT_BASE_URLS.ollama,
    }
  );

  const handleProviderChange = (provider: ModelOverride['provider']) => {
    setDraft({
      provider,
      modelName: DEFAULT_MODELS[provider],
      baseUrl: DEFAULT_BASE_URLS[provider],
      apiKey: '',
    });
  };

  const handleSave = async () => {
    setError(null);

    // 基本校验
    if (!draft.modelName.trim()) {
      setError('模型名称不能为空');
      return;
    }
    if ((draft.provider === 'openai' || draft.provider === 'custom') && !draft.apiKey?.trim()) {
      setError('OpenAI / Custom 提供商需要 API Key');
      return;
    }
    if (draft.provider === 'custom' && !draft.baseUrl?.trim()) {
      setError('Custom 提供商需要 Base URL');
      return;
    }

    setSaving(true);
    try {
      await onSave(draft);
      onChange(draft);
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(null);
      onChange(null);
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setSaving(false);
    }
  };

  const displayText = value
    ? `${PROVIDER_LABELS[value.provider]} · ${value.modelName}`
    : '使用默认模型';

  return (
    <div className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 uppercase tracking-wider">模型</span>
          <span className="px-3 py-1 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200">
            {displayText}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(prev => !prev)}
          className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
        >
          {expanded ? '收起' : '配置模型'}
        </button>
      </div>

      {expanded && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-4">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-3">
            {/* Provider */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">提供商</label>
              <div className="flex gap-2">
                {(Object.keys(PROVIDER_LABELS) as ModelOverride['provider'][]).map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleProviderChange(p)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      draft.provider === p
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {PROVIDER_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* 模型名 */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">模型名称</label>
              <input
                type="text"
                value={draft.modelName}
                onChange={e => setDraft({ ...draft, modelName: e.target.value })}
                placeholder={DEFAULT_MODELS[draft.provider]}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {/* Base URL */}
            {(draft.provider === 'ollama' || draft.provider === 'custom' || draft.provider === 'openai') && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Base URL {draft.provider === 'openai' && <span className="text-slate-500">(可选)</span>}
                </label>
                <input
                  type="text"
                  value={draft.baseUrl || ''}
                  onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder={DEFAULT_BASE_URLS[draft.provider] || 'https://api.example.com/v1'}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            )}

            {/* API Key */}
            {(draft.provider === 'openai' || draft.provider === 'custom') && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={draft.apiKey || ''}
                  onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder="sk-..."
                  autoComplete="off"
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono"
                />
              </div>
            )}

            {error && (
              <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              {value && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
                >
                  重置为默认
                </button>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  saving
                    ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                    : 'bg-purple-600 text-white hover:bg-purple-500'
                }`}
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
