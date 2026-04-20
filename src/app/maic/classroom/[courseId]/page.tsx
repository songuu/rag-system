'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

type Role =
  | 'teacher'
  | 'ta'
  | 'clown'
  | 'thinker'
  | 'notetaker'
  | 'inquisitive'
  | 'student';

interface Utterance {
  id: string;
  speaker: Role;
  speaker_name: string;
  content: string;
  timestamp: string;
}

interface ClassroomState {
  P_t: number;
  H_t: Utterance[];
  R: string[];
  mode: 'continuous' | 'interactive';
  status: 'idle' | 'running' | 'paused' | 'ended' | 'error';
  script_cursor: number;
}

interface ClassroomEvent {
  type: 'utterance' | 'slide_change' | 'state' | 'mode' | 'end' | 'error';
  data: unknown;
}

interface SlidePage {
  index: number;
  raw_text: string;
  description: string;
  key_points: string[];
}

interface Course {
  course_id: string;
  title: string;
  prepared?: {
    pages: SlidePage[];
    active_questions: string[];
  };
}

const AVATAR: Record<Role, string> = {
  teacher: '👩‍🏫',
  ta: '🧑‍🔧',
  clown: '🤡',
  thinker: '🧠',
  notetaker: '📝',
  inquisitive: '🙋',
  student: '🧑‍🎓',
};

const ROLE_COLOR: Record<Role, string> = {
  teacher: 'border-emerald-500/40 bg-emerald-500/10',
  ta: 'border-sky-500/40 bg-sky-500/10',
  clown: 'border-amber-500/40 bg-amber-500/10',
  thinker: 'border-violet-500/40 bg-violet-500/10',
  notetaker: 'border-slate-500/40 bg-slate-500/10',
  inquisitive: 'border-rose-500/40 bg-rose-500/10',
  student: 'border-slate-400/60 bg-slate-700/60',
};

export default function ClassroomPage() {
  const params = useParams<{ courseId: string }>();
  const courseId = params.courseId;

  const [course, setCourse] = useState<Course | null>(null);
  const [state, setState] = useState<ClassroomState | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // 加载课程
  useEffect(() => {
    if (!courseId) return;
    void fetch(`/api/maic/courses/${courseId}`)
      .then(r => r.json())
      .then(json => {
        if (json.success) setCourse(json.data as Course);
      });
  }, [courseId]);

  // 订阅 SSE
  useEffect(() => {
    if (!courseId) return;
    const es = new EventSource(`/api/maic/classroom/${courseId}`);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = ev => {
      try {
        const parsed = JSON.parse(ev.data) as ClassroomEvent;
        switch (parsed.type) {
          case 'utterance': {
            const u = parsed.data as Utterance;
            setUtterances(prev => (prev.find(p => p.id === u.id) ? prev : [...prev, u]));
            break;
          }
          case 'state': {
            const s = parsed.data as ClassroomState;
            setState(s);
            if (Array.isArray(s.H_t) && s.H_t.length > 0) {
              setUtterances(prev => {
                const map = new Map(prev.map(p => [p.id, p]));
                for (const u of s.H_t) map.set(u.id, u);
                return Array.from(map.values()).sort((a, b) =>
                  a.timestamp.localeCompare(b.timestamp)
                );
              });
            }
            break;
          }
          case 'slide_change': {
            const d = parsed.data as { slide_index: number };
            setState(prev => (prev ? { ...prev, P_t: d.slide_index } : prev));
            break;
          }
          case 'end':
            setEnded(true);
            break;
          case 'error':
            // swallow — 显示在 chat 流
            break;
          default:
            break;
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [courseId]);

  // 自动滚动聊天
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [utterances]);

  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await fetch(`/api/maic/classroom/${courseId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, mode: 'interactive' }),
      });
      setInput('');
    } finally {
      setSending(false);
    }
  }, [courseId, input, sending]);

  const setMode = useCallback(
    async (mode: 'continuous' | 'interactive') => {
      await fetch(`/api/maic/classroom/${courseId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    },
    [courseId]
  );

  const currentPage = state && course?.prepared
    ? course.prepared.pages[state.P_t]
    : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      {/* 左: slide + 角色 */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">{course?.title ?? '课堂'}</h1>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`}
            />
            {connected ? '在线' : '离线'} · {state?.status ?? 'idle'}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-8 shadow-xl">
          <div className="mb-4 flex items-center justify-between text-xs text-slate-500">
            <span>
              第 {(state?.P_t ?? 0) + 1} / {course?.prepared?.pages.length ?? 0} 页
            </span>
            <span>游标 {state?.script_cursor ?? 0}</span>
          </div>
          {currentPage ? (
            <>
              <div className="mb-4 line-clamp-3 text-lg font-semibold leading-snug text-slate-100">
                {currentPage.description || currentPage.raw_text.slice(0, 160)}
              </div>
              <ul className="space-y-2 text-sm text-slate-300">
                {currentPage.key_points.map((k, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-emerald-400">▸</span>
                    <span>{k}</span>
                  </li>
                ))}
              </ul>
              {currentPage.key_points.length === 0 && (
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-slate-400">
                  {currentPage.raw_text.slice(0, 1200)}
                </pre>
              )}
            </>
          ) : (
            <div className="text-sm text-slate-500">加载课件…</div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {state?.R.map(role => (
            <div
              key={role}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                ROLE_COLOR[role as Role] ?? ROLE_COLOR.student
              }`}
            >
              <span>{AVATAR[role as Role] ?? '🤖'}</span>
              <span>{role}</span>
            </div>
          ))}
        </div>

        {course?.prepared?.active_questions && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
              课堂主动提问
            </div>
            <ul className="space-y-1 text-sm text-slate-300">
              {course.prepared.active_questions.slice(0, 4).map((q, i) => (
                <li key={i}>· {q}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* 右: 聊天 + 输入 */}
      <div className="flex h-[calc(100vh-10rem)] flex-col rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center justify-between border-b border-slate-800 p-4">
          <div className="text-sm font-semibold text-slate-200">课堂对话</div>
          <div className="flex overflow-hidden rounded-full border border-slate-700 text-xs">
            <button
              type="button"
              onClick={() => setMode('continuous')}
              className={`px-3 py-1 ${
                state?.mode === 'continuous'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              连续
            </button>
            <button
              type="button"
              onClick={() => setMode('interactive')}
              className={`px-3 py-1 ${
                state?.mode === 'interactive'
                  ? 'bg-emerald-500 text-slate-950'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              交互
            </button>
          </div>
        </div>

        <div ref={chatRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {utterances.map(u => {
            const isMe = u.speaker === 'student';
            return (
              <div
                key={u.id}
                className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}
              >
                <div className="mt-1 text-xl">
                  {AVATAR[u.speaker] ?? '🤖'}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl border px-3 py-2 text-sm ${
                    ROLE_COLOR[u.speaker] ?? ROLE_COLOR.student
                  }`}
                >
                  <div className="mb-1 text-xs font-semibold text-slate-300">
                    {u.speaker_name}
                  </div>
                  <div className="whitespace-pre-wrap text-slate-100">{u.content}</div>
                </div>
              </div>
            );
          })}
          {utterances.length === 0 && (
            <div className="text-center text-sm text-slate-500">
              课堂即将开始…
            </div>
          )}
          {ended && (
            <div className="rounded-xl bg-slate-800/60 p-3 text-center text-xs text-slate-400">
              ✅ 课堂已结束
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 p-3">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              rows={2}
              placeholder="提问或请求换一种讲法…(Enter 发送, Shift+Enter 换行)"
              className="flex-1 resize-none rounded-xl border border-slate-700 bg-slate-900/60 p-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={sending || !input.trim()}
              className="rounded-xl bg-emerald-500 px-4 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              发送
            </button>
          </div>
          <div className="mt-2 text-[10px] text-slate-500">
            交互模式下,你的提问会立即打断当前发言并由老师优先回答。
          </div>
        </div>
      </div>
    </div>
  );
}
