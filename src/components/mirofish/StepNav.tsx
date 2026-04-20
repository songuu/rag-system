'use client';

import React from 'react';

interface Step {
  key: number;
  label: string;
  emoji: string;
  description: string;
}

const STEPS: Step[] = [
  { key: 0, label: '图谱构建', emoji: '🧬', description: '上传文档，构建知识图谱' },
  { key: 1, label: '环境设置', emoji: '⚙️', description: '生成 Agent 人设，配置模拟' },
  { key: 2, label: '模拟运行', emoji: '🎭', description: '启动多 Agent 社交媒体模拟' },
  { key: 3, label: '报告生成', emoji: '📊', description: '分析数据，生成深度报告' },
  { key: 4, label: '深度交互', emoji: '💬', description: '与 Agent 对话，深度挖掘' },
];

interface StepNavProps {
  currentStep: number;
  maxStep: number;
  onStepChange: (step: number) => void;
}

export default function StepNav({ currentStep, maxStep, onStepChange }: StepNavProps) {
  return (
    <div className="relative border-b border-white/[0.06] bg-black/40 backdrop-blur-xl">
      {/* 顶部发光线 */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-purple-500/40 to-transparent" />

      <div className="mx-auto flex max-w-6xl items-center px-6 py-3">
        {STEPS.map((step, index) => {
          const isActive = currentStep === step.key;
          const isCompleted = step.key < maxStep;
          const isClickable = step.key <= maxStep;

          return (
            <React.Fragment key={step.key}>
              {index > 0 && (
                <div className="mx-1 flex flex-1 items-center">
                  <div
                    className={`h-[2px] w-full rounded-full transition-all duration-500 ${
                      isCompleted
                        ? 'bg-gradient-to-r from-purple-500 to-purple-400'
                        : 'bg-white/[0.08]'
                    }`}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => isClickable && onStepChange(step.key)}
                disabled={!isClickable}
                className={`group relative flex items-center gap-2.5 rounded-xl px-4 py-2.5 transition-all duration-300 ${
                  isActive
                    ? 'bg-purple-500/15 shadow-[0_0_20px_rgba(124,58,237,0.15)]'
                    : isCompleted
                      ? 'hover:bg-purple-500/10'
                      : ''
                } ${isClickable ? 'cursor-pointer' : 'cursor-not-allowed opacity-35'}`}
              >
                {/* 活跃状态边框发光 */}
                {isActive && (
                  <div className="absolute inset-0 rounded-xl border border-purple-500/40" />
                )}

                {/* 序号圆 */}
                <div
                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-all duration-300 ${
                    isActive
                      ? 'bg-gradient-to-br from-purple-500 to-violet-600 text-white shadow-[0_0_12px_rgba(124,58,237,0.5)]'
                      : isCompleted
                        ? 'bg-purple-500/80 text-white'
                        : 'bg-white/[0.08] text-white/40'
                  }`}
                >
                  {isCompleted && !isActive ? (
                    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" role="img">
                      <title>completed</title>
                      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                    </svg>
                  ) : (
                    <span>{step.emoji}</span>
                  )}
                  {isActive && (
                    <div className="absolute inset-0 animate-ping rounded-full bg-purple-400/20" />
                  )}
                </div>

                {/* 标签 */}
                <div className="hidden sm:block">
                  <div
                    className={`text-[13px] font-semibold whitespace-nowrap transition-colors ${
                      isActive
                        ? 'text-white'
                        : isCompleted
                          ? 'text-purple-300/90'
                          : 'text-white/40'
                    }`}
                  >
                    {step.label}
                  </div>
                  <div
                    className={`text-[10px] transition-colors ${
                      isActive
                        ? 'text-purple-300/70'
                        : 'text-white/20'
                    }`}
                  >
                    {step.description}
                  </div>
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
