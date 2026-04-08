'use client';

import React from 'react';

interface Step {
  key: number;
  label: string;
  icon: string;
  description: string;
}

const STEPS: Step[] = [
  { key: 0, label: '图谱构建', icon: '1', description: '上传文档，构建知识图谱' },
  { key: 1, label: '环境设置', icon: '2', description: '生成Agent人设，配置模拟' },
  { key: 2, label: '模拟运行', icon: '3', description: '启动社交媒体模拟' },
  { key: 3, label: '报告生成', icon: '4', description: '分析模拟数据，生成报告' },
  { key: 4, label: '深度交互', icon: '5', description: '与ReportAgent对话，采访Agent' },
];

interface StepNavProps {
  currentStep: number;
  maxStep: number;
  onStepChange: (step: number) => void;
}

export default function StepNav({ currentStep, maxStep, onStepChange }: StepNavProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      padding: '12px 24px',
      background: '#0f0f0f',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}>
      {STEPS.map((step, index) => {
        const isActive = currentStep === step.key;
        const isCompleted = step.key < maxStep;
        const isClickable = step.key <= maxStep;

        return (
          <React.Fragment key={step.key}>
            {index > 0 && (
              <div style={{
                flex: 1,
                height: '2px',
                background: isCompleted ? '#7C3AED' : 'rgba(255,255,255,0.1)',
                transition: 'background 0.3s',
              }} />
            )}
            <button
              type="button"
              onClick={() => isClickable && onStepChange(step.key)}
              disabled={!isClickable}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                borderRadius: '8px',
                border: isActive ? '1px solid #7C3AED' : '1px solid transparent',
                background: isActive
                  ? 'rgba(124, 58, 237, 0.15)'
                  : isCompleted
                    ? 'rgba(124, 58, 237, 0.08)'
                    : 'transparent',
                cursor: isClickable ? 'pointer' : 'not-allowed',
                opacity: isClickable ? 1 : 0.4,
                transition: 'all 0.2s',
              }}
            >
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '13px',
                fontWeight: 700,
                background: isActive
                  ? '#7C3AED'
                  : isCompleted
                    ? '#7C3AED'
                    : 'rgba(255,255,255,0.1)',
                color: isActive || isCompleted ? '#fff' : 'rgba(255,255,255,0.4)',
              }}>
                {isCompleted && !isActive ? '\u2713' : step.icon}
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{
                  fontSize: '13px',
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? '#fff' : isCompleted ? '#c4b5fd' : 'rgba(255,255,255,0.5)',
                  whiteSpace: 'nowrap',
                }}>
                  {step.label}
                </div>
              </div>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
