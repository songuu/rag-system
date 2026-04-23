'use client';

import React, {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AgentRole,
  ClassroomEvent,
  ClassroomMode,
  ClassroomState,
  Course,
  CourseScene,
  CourseSceneType,
  SlidePage,
  TeachingAction,
  Utterance,
} from '@/lib/maic/types';

type SpeakerRole = AgentRole | 'student';

interface OpenMaicClassroomProps {
  courseId: string;
}

interface StageEffect {
  kind: 'spotlight' | 'laser' | 'discussion';
  label: string;
}

const ROLE_META: Record<SpeakerRole, { name: string; initials: string; tone: string }> = {
  teacher: { name: '老师', initials: 'T', tone: 'from-emerald-300 to-teal-500' },
  ta: { name: '助教', initials: 'TA', tone: 'from-sky-300 to-blue-500' },
  clown: { name: '活跃同学', initials: 'C', tone: 'from-amber-300 to-orange-500' },
  thinker: { name: '深度思考者', initials: 'D', tone: 'from-indigo-300 to-violet-500' },
  notetaker: { name: '笔记员', initials: 'N', tone: 'from-slate-300 to-slate-500' },
  inquisitive: { name: '好问者', initials: 'Q', tone: 'from-rose-300 to-pink-500' },
  manager: { name: '课堂管理者', initials: 'M', tone: 'from-zinc-300 to-zinc-500' },
  student: { name: '我', initials: 'Me', tone: 'from-lime-300 to-green-500' },
};

const SCENE_LABELS: Record<CourseSceneType, string> = {
  slide: 'Slides',
  quiz: 'Quiz',
  interactive: 'Simulation',
  pbl: 'PBL',
  mindmap: 'Mind Map',
  code: 'Code Lab',
};

export function OpenMaicClassroom({ courseId }: OpenMaicClassroomProps) {
  const [course, setCourse] = useState<Course | null>(null);
  const [classroomState, setClassroomState] = useState<ClassroomState | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [studentInput, setStudentInput] = useState('');
  const deferredStudentInput = useDeferredValue(studentInput);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stageEffect, setStageEffect] = useState<StageEffect | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [quizAnswers, setQuizAnswers] = useState<Record<string, number>>({});
  const [codeDraft, setCodeDraft] = useState('const insight = "learning by doing";\nconsole.log(insight);');
  const [runOutput, setRunOutput] = useState('等待运行');
  const [selectedPblRole, setSelectedPblRole] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const sceneViewportRef = useRef<HTMLDivElement | null>(null);

  const pages = course?.prepared?.pages ?? [];
  const scenes = useMemo(() => deriveScenes(course), [course]);
  const currentPageIndex = classroomState?.P_t ?? 0;
  const automaticScene = useMemo(
    () =>
      scenes.find(scene => scene.type === 'slide' && scene.page_refs.includes(currentPageIndex)) ??
      scenes[0],
    [currentPageIndex, scenes]
  );
  const selectedScene = scenes.find(scene => scene.id === selectedSceneId) ?? automaticScene;
  const currentPage = pages[currentPageIndex];
  const latestUtterance = utterances.at(-1);
  const courseReady = course?.status === 'ready' && !!course.prepared;

  const handleClassroomEvent = useCallback((event: ClassroomEvent) => {
    switch (event.type) {
      case 'utterance':
        setUtterances(prev => appendUtterance(prev, event.data));
        break;
      case 'state':
        setClassroomState(event.data);
        setUtterances(prev => mergeUtterances(prev, event.data.H_t));
        break;
      case 'slide_change':
        setClassroomState(prev => (prev ? { ...prev, P_t: event.data.slide_index } : prev));
        break;
      case 'mode':
        setClassroomState(prev => (prev ? { ...prev, mode: event.data.mode } : prev));
        break;
      case 'end':
        setClassroomState(prev => (prev ? { ...prev, status: 'ended' } : prev));
        break;
      case 'error':
        setUtterances(prev => appendUtterance(prev, makeSystemUtterance(event.data.message)));
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadCourse(): Promise<void> {
      try {
        const response = await fetch(`/api/maic/courses/${courseId}`);
        const json = await response.json();
        if (!cancelled && json.success) {
          setCourse(json.data as Course);
        }
      } catch {
        if (!cancelled) setCourse(null);
      }
    }
    void loadCourse();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !courseReady) return;
    const eventSource = new EventSource(`/api/maic/classroom/${courseId}`);
    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    eventSource.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as ClassroomEvent;
        startTransition(() => handleClassroomEvent(parsed));
      } catch {
        // Ignore malformed SSE frames instead of breaking the classroom.
      }
    };
    return () => {
      eventSource.close();
    };
  }, [courseId, courseReady, handleClassroomEvent]);

  useEffect(() => {
    if (!automaticScene || selectedSceneId) return;
    setSelectedSceneId(automaticScene.id);
  }, [automaticScene, selectedSceneId]);

  useEffect(() => {
    const nextScene = scenes.find(scene =>
      scene.type === 'slide' && scene.page_refs.includes(currentPageIndex)
    );
    if (nextScene) setSelectedSceneId(nextScene.id);
  }, [currentPageIndex, scenes]);

  useEffect(() => {
    if (!latestUtterance) return;
    const effect = toStageEffect(latestUtterance.action);
    setStageEffect(effect);
    if (!effect) return;
    const timer = window.setTimeout(() => setStageEffect(null), 4200);
    return () => window.clearTimeout(timer);
  }, [latestUtterance]);

  useEffect(() => {
    if (!ttsEnabled || !latestUtterance || latestUtterance.speaker === 'student') return;
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const speech = new SpeechSynthesisUtterance(latestUtterance.content);
    speech.lang = mostlyChinese(latestUtterance.content) ? 'zh-CN' : 'en-US';
    speech.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(speech);
    return () => window.speechSynthesis.cancel();
  }, [latestUtterance, ttsEnabled]);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [utterances]);

  const postClassroom = useCallback(
    async (payload: Record<string, unknown>) => {
      await fetch(`/api/maic/classroom/${courseId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    [courseId]
  );

  const sendMessage = useCallback(async () => {
    const content = studentInput.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await postClassroom({ content, mode: 'interactive' });
      setStudentInput('');
    } finally {
      setSending(false);
    }
  }, [postClassroom, sending, studentInput]);

  const setMode = useCallback(
    async (mode: ClassroomMode) => {
      await postClassroom({ mode });
    },
    [postClassroom]
  );

  const sendControl = useCallback(
    async (control: 'pause' | 'resume' | 'restart') => {
      await postClassroom({ control });
    },
    [postClassroom]
  );

  const navigateToSlide = useCallback(
    async (slideIndex: number) => {
      const clamped = Math.max(0, Math.min(slideIndex, Math.max(pages.length - 1, 0)));
      await postClassroom({ control: 'navigate', slide_index: clamped });
      const slideScene = scenes.find(scene => scene.type === 'slide' && scene.page_refs.includes(clamped));
      if (slideScene) setSelectedSceneId(slideScene.id);
    },
    [pages.length, postClassroom, scenes]
  );

  const selectScene = useCallback(
    async (scene: CourseScene) => {
      setSelectedSceneId(scene.id);
      const firstPageRef = scene.page_refs[0];
      if (scene.type === 'slide' && firstPageRef !== undefined) {
        await navigateToSlide(firstPageRef);
      }
    },
    [navigateToSlide]
  );

  const runCodeLab = useCallback(() => {
    const output = codeDraft.includes('console.log')
      ? codeDraft
          .split('\n')
          .find(line => line.includes('console.log'))
          ?.replace(/console\.log\((.*)\);?/, '$1')
          .replaceAll('"', '')
          .replaceAll("'", '')
          .trim() || '已运行'
      : '已保存你的代码草稿';
    setRunOutput(output);
  }, [codeDraft]);

  const exportHtml = useCallback(() => {
    if (!course || typeof window === 'undefined') return;
    const sceneCards = scenes
      .map(scene => {
        const points = scene.key_points.map(point => `<li>${escapeHtml(point)}</li>`).join('');
        return `<section class="scene"><p class="kind">${escapeHtml(SCENE_LABELS[scene.type])}</p><h2>${escapeHtml(scene.title)}</h2><p>${escapeHtml(scene.description)}</p><ul>${points}</ul></section>`;
      })
      .join('\n');
    const payload = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(course.title)}</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui; background: #08111f; color: #e5eefb; }
    main { max-width: 1080px; margin: 0 auto; padding: 48px 24px; }
    .hero, .scene { border: 1px solid rgba(255,255,255,.12); border-radius: 28px; background: rgba(255,255,255,.06); padding: 28px; margin-bottom: 18px; }
    .kind { color: #5eead4; letter-spacing: .22em; text-transform: uppercase; font-size: 12px; }
    h1 { font-size: 42px; margin: 0 0 12px; }
    h2 { font-size: 28px; margin: 6px 0 12px; }
    li { margin: 8px 0; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="kind">OpenMAIC Export</p>
      <h1>${escapeHtml(course.title)}</h1>
      <p>${escapeHtml(course.prepared?.stage?.summary ?? '多智能体交互课堂导出')}</p>
    </section>
    ${sceneCards}
  </main>
</body>
</html>`;
    const blob = new Blob([payload], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${course.course_id}-openmaic-classroom.html`;
    link.click();
    URL.revokeObjectURL(url);
  }, [course, scenes]);

  if (!course) {
    return (
      <div className="grid min-h-[70vh] place-items-center text-slate-400">
        正在加载 OpenMAIC 课堂...
      </div>
    );
  }

  if (!courseReady) {
    return (
      <div className="mx-auto max-w-3xl rounded-3xl border border-amber-400/30 bg-amber-400/10 p-8 text-amber-100">
        课程尚未准备完成，请先返回准备页完成 Read/Plan/Scenes 流水线。
      </div>
    );
  }

  return (
    <div className="relative min-h-[calc(100vh-5.5rem)] overflow-hidden rounded-[2rem] border border-white/10 bg-[#090d14] text-slate-100 shadow-2xl">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(20,184,166,0.22),transparent_34%),radial-gradient(circle_at_80%_10%,rgba(59,130,246,0.18),transparent_30%),linear-gradient(135deg,rgba(15,23,42,0.95),rgba(2,6,23,0.98))]" />
      <div className="relative z-10 flex min-h-[calc(100vh-5.5rem)]">
        <SceneSidebar
          collapsed={sidebarCollapsed}
          scenes={scenes}
          activeSceneId={selectedScene?.id}
          stageTitle={course.prepared?.stage.title ?? course.title}
          onCollapse={() => setSidebarCollapsed(prev => !prev)}
          onSelectScene={selectScene}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <StageHeader
            title={course.title}
            status={classroomState?.status ?? 'idle'}
            mode={classroomState?.mode ?? 'continuous'}
            connected={connected}
            pageIndex={currentPageIndex}
            pageCount={pages.length}
            scenesCount={scenes.length}
            ttsEnabled={ttsEnabled}
            whiteboardOpen={whiteboardOpen}
            onModeChange={setMode}
            onPause={() => sendControl('pause')}
            onResume={() => sendControl('resume')}
            onRestart={() => sendControl('restart')}
            onPrev={() => navigateToSlide(currentPageIndex - 1)}
            onNext={() => navigateToSlide(currentPageIndex + 1)}
            onToggleTts={() => setTtsEnabled(prev => !prev)}
            onToggleWhiteboard={() => setWhiteboardOpen(prev => !prev)}
            onToggleChat={() => setChatCollapsed(prev => !prev)}
            onExport={exportHtml}
          />

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section ref={sceneViewportRef} className="min-h-0 overflow-hidden rounded-[1.75rem] border border-white/10 bg-white/[0.04] shadow-inner">
              <SceneViewport
                scene={selectedScene}
                page={currentPage}
                effect={stageEffect}
                whiteboardOpen={whiteboardOpen}
                utterance={latestUtterance}
                quizAnswers={quizAnswers}
                codeDraft={codeDraft}
                runOutput={runOutput}
                selectedPblRole={selectedPblRole}
                onQuizAnswer={(id, value) => setQuizAnswers(prev => ({ ...prev, [id]: value }))}
                onCodeDraftChange={setCodeDraft}
                onRunCode={runCodeLab}
                onPblRoleSelect={setSelectedPblRole}
              />
            </section>

            {!chatCollapsed && (
              <ClassroomChat
                ref={chatRef}
                utterances={utterances}
                mode={classroomState?.mode ?? 'continuous'}
                input={studentInput}
                deferredInput={deferredStudentInput}
                sending={sending}
                activeQuestions={course.prepared?.active_questions ?? []}
                roles={classroomState?.R ?? []}
                latestSpeaker={latestUtterance?.speaker}
                onInputChange={setStudentInput}
                onSend={sendMessage}
                onModeChange={setMode}
                onQuickAsk={question => setStudentInput(question)}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

interface SceneSidebarProps {
  collapsed: boolean;
  scenes: CourseScene[];
  activeSceneId?: string;
  stageTitle: string;
  onCollapse: () => void;
  onSelectScene: (scene: CourseScene) => void;
}

function SceneSidebar({
  collapsed,
  scenes,
  activeSceneId,
  stageTitle,
  onCollapse,
  onSelectScene,
}: SceneSidebarProps) {
  return (
    <aside
      className={`hidden border-r border-white/10 bg-black/20 transition-all duration-300 lg:block ${
        collapsed ? 'w-20' : 'w-80'
      }`}
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-white/10 p-4">
          <button
            type="button"
            onClick={onCollapse}
            className="mb-4 rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
          >
            {collapsed ? '展开' : '收起'}
          </button>
          {!collapsed && (
            <>
              <div className="text-xs uppercase tracking-[0.35em] text-teal-200/70">
                OpenMAIC Stage
              </div>
              <h2 className="mt-2 line-clamp-2 text-lg font-semibold">{stageTitle}</h2>
            </>
          )}
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {scenes.map(scene => {
            const active = scene.id === activeSceneId;
            return (
              <button
                key={scene.id}
                type="button"
                onClick={() => onSelectScene(scene)}
                className={`w-full rounded-2xl border p-3 text-left transition ${
                  active
                    ? 'border-teal-300/50 bg-teal-300/15 shadow-lg shadow-teal-950/40'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-xs font-semibold">
                    {String(scene.order + 1).padStart(2, '0')}
                  </div>
                  {!collapsed && (
                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-slate-400">
                        {SCENE_LABELS[scene.type]}
                      </div>
                      <div className="line-clamp-2 text-sm font-medium text-slate-100">
                        {scene.title}
                      </div>
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

interface StageHeaderProps {
  title: string;
  status: ClassroomState['status'];
  mode: ClassroomMode;
  connected: boolean;
  pageIndex: number;
  pageCount: number;
  scenesCount: number;
  ttsEnabled: boolean;
  whiteboardOpen: boolean;
  onModeChange: (mode: ClassroomMode) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleTts: () => void;
  onToggleWhiteboard: () => void;
  onToggleChat: () => void;
  onExport: () => void;
}

function StageHeader({
  title,
  status,
  mode,
  connected,
  pageIndex,
  pageCount,
  scenesCount,
  ttsEnabled,
  whiteboardOpen,
  onModeChange,
  onPause,
  onResume,
  onRestart,
  onPrev,
  onNext,
  onToggleTts,
  onToggleWhiteboard,
  onToggleChat,
  onExport,
}: StageHeaderProps) {
  const isPaused = status === 'paused' || status === 'idle';
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-black/20 px-4 py-3 backdrop-blur-xl">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-slate-400">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-teal-300' : 'bg-slate-600'}`} />
          {connected ? 'Live Classroom' : 'Offline'} / {status}
        </div>
        <h1 className="mt-1 line-clamp-1 text-lg font-semibold">{title}</h1>
      </div>

      <div className="flex items-center overflow-hidden rounded-full border border-white/10 bg-white/[0.04] p-1 text-xs">
        <button
          type="button"
          onClick={() => onModeChange('continuous')}
          className={`rounded-full px-3 py-1.5 ${mode === 'continuous' ? 'bg-teal-300 text-slate-950' : 'text-slate-300'}`}
        >
          Continuous
        </button>
        <button
          type="button"
          onClick={() => onModeChange('interactive')}
          className={`rounded-full px-3 py-1.5 ${mode === 'interactive' ? 'bg-teal-300 text-slate-950' : 'text-slate-300'}`}
        >
          Interactive
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <HeaderButton onClick={onPrev}>上一页</HeaderButton>
        <HeaderButton onClick={isPaused ? onResume : onPause}>
          {isPaused ? '播放' : '暂停'}
        </HeaderButton>
        <HeaderButton onClick={onNext}>下一页</HeaderButton>
        <HeaderButton onClick={onRestart}>重播</HeaderButton>
        <HeaderButton active={whiteboardOpen} onClick={onToggleWhiteboard}>白板</HeaderButton>
        <HeaderButton active={ttsEnabled} onClick={onToggleTts}>TTS</HeaderButton>
        <HeaderButton onClick={onToggleChat}>聊天</HeaderButton>
        <HeaderButton onClick={onExport}>导出</HeaderButton>
      </div>

      <div className="w-full text-[11px] text-slate-500 md:w-auto">
        Slide {Math.min(pageIndex + 1, pageCount)} / {pageCount} · Scene {scenesCount}
      </div>
    </header>
  );
}

function HeaderButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 transition ${
        active
          ? 'border-teal-300/60 bg-teal-300/15 text-teal-100'
          : 'border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

interface SceneViewportProps {
  scene?: CourseScene;
  page?: SlidePage;
  effect: StageEffect | null;
  whiteboardOpen: boolean;
  utterance?: Utterance;
  quizAnswers: Record<string, number>;
  codeDraft: string;
  runOutput: string;
  selectedPblRole: string | null;
  onQuizAnswer: (id: string, value: number) => void;
  onCodeDraftChange: (value: string) => void;
  onRunCode: () => void;
  onPblRoleSelect: (role: string) => void;
}

function SceneViewport({
  scene,
  page,
  effect,
  whiteboardOpen,
  utterance,
  quizAnswers,
  codeDraft,
  runOutput,
  selectedPblRole,
  onQuizAnswer,
  onCodeDraftChange,
  onRunCode,
  onPblRoleSelect,
}: SceneViewportProps) {
  if (!scene) {
    return <div className="grid h-full min-h-[34rem] place-items-center text-slate-500">暂无场景</div>;
  }

  return (
    <div className="relative h-full min-h-[34rem] overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:42px_42px]" />
      <div className="relative z-10 grid h-full gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-0 rounded-[1.5rem] border border-white/10 bg-slate-950/60 p-5">
          <SceneCanvas
            scene={scene}
            page={page}
            effect={effect}
            quizAnswers={quizAnswers}
            codeDraft={codeDraft}
            runOutput={runOutput}
            selectedPblRole={selectedPblRole}
            onQuizAnswer={onQuizAnswer}
            onCodeDraftChange={onCodeDraftChange}
            onRunCode={onRunCode}
            onPblRoleSelect={onPblRoleSelect}
          />
        </div>

        <aside className="hidden min-h-0 space-y-4 lg:block">
          <ActionTimeline scene={scene} effect={effect} />
          {whiteboardOpen && <Whiteboard scene={scene} utterance={utterance} />}
        </aside>
      </div>
    </div>
  );
}

interface SceneCanvasProps extends Omit<SceneViewportProps, 'scene' | 'whiteboardOpen' | 'utterance'> {
  scene: CourseScene;
}

function SceneCanvas({
  scene,
  page,
  effect,
  quizAnswers,
  codeDraft,
  runOutput,
  selectedPblRole,
  onQuizAnswer,
  onCodeDraftChange,
  onRunCode,
  onPblRoleSelect,
}: SceneCanvasProps) {
  if (scene.type === 'quiz') {
    return <QuizScene scene={scene} answers={quizAnswers} onAnswer={onQuizAnswer} />;
  }
  if (scene.type === 'interactive' || scene.type === 'mindmap') {
    return <InteractiveScene scene={scene} />;
  }
  if (scene.type === 'code') {
    return (
      <CodeScene
        scene={scene}
        codeDraft={codeDraft}
        output={runOutput}
        onCodeDraftChange={onCodeDraftChange}
        onRunCode={onRunCode}
      />
    );
  }
  if (scene.type === 'pbl') {
    return (
      <PblScene
        scene={scene}
        selectedRole={selectedPblRole}
        onRoleSelect={onPblRoleSelect}
      />
    );
  }
  return <SlideScene scene={scene} page={page} effect={effect} />;
}

function SlideScene({
  scene,
  page,
  effect,
}: {
  scene: CourseScene;
  page?: SlidePage;
  effect: StageEffect | null;
}) {
  const points = scene.key_points.length > 0 ? scene.key_points : page?.key_points ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-teal-200/70">Slide Lecture</div>
          <h2 className="mt-3 text-3xl font-semibold leading-tight text-white">{scene.title}</h2>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-slate-300">
          Page {(page?.index ?? scene.page_refs[0] ?? 0) + 1}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-[1.5rem] border border-white/10 bg-gradient-to-br from-slate-100 to-white p-8 text-slate-950 shadow-2xl">
        {effect?.kind === 'spotlight' && (
          <div className="pointer-events-none absolute inset-0 bg-slate-950/30 mix-blend-multiply" />
        )}
        {effect?.kind === 'laser' && (
          <div className="pointer-events-none absolute left-[18%] top-[22%] h-28 w-28 rounded-full border-2 border-red-500/80 shadow-[0_0_32px_rgba(239,68,68,0.75)]" />
        )}

        <div className="relative z-10 max-w-4xl">
          <p className="mb-8 max-w-3xl text-xl leading-relaxed text-slate-700">
            {scene.description}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {points.slice(0, 4).map((point, index) => (
              <div
                key={`${point}-${index}`}
                className={`rounded-2xl border p-5 shadow-sm ${
                  index === 0 && effect?.kind === 'spotlight'
                    ? 'border-teal-400 bg-teal-50 shadow-teal-200/80'
                    : 'border-slate-200 bg-white/80'
                }`}
              >
                <div className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Key {index + 1}
                </div>
                <div className="text-lg font-semibold leading-snug">{point}</div>
              </div>
            ))}
          </div>
          {points.length === 0 && (
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-5 text-sm text-slate-100">
              {page?.raw_text.slice(0, 1600)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function QuizScene({
  scene,
  answers,
  onAnswer,
}: {
  scene: CourseScene;
  answers: Record<string, number>;
  onAnswer: (id: string, value: number) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-amber-200/70">Interactive Quiz</div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.description}</p>
      </div>
      {scene.quiz?.map(question => {
        const selected = answers[question.id];
        const answered = selected !== undefined;
        return (
          <div key={question.id} className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
            <h3 className="mb-4 text-lg font-semibold">{question.question}</h3>
            <div className="grid gap-3">
              {question.options.map((option, index) => {
                const correct = index === question.answer_index;
                const picked = selected === index;
                return (
                  <button
                    key={`${question.id}-${option}`}
                    type="button"
                    onClick={() => onAnswer(question.id, index)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      answered && correct
                        ? 'border-teal-300 bg-teal-300/15'
                        : picked
                          ? 'border-amber-300 bg-amber-300/15'
                          : 'border-white/10 bg-slate-950/40 hover:bg-white/10'
                    }`}
                  >
                    <span className="mr-3 text-xs text-slate-400">{String.fromCharCode(65 + index)}</span>
                    {option}
                  </button>
                );
              })}
            </div>
            {answered && (
              <div className="mt-4 rounded-2xl border border-teal-300/30 bg-teal-300/10 p-4 text-sm text-teal-50">
                AI 讲评: {question.explanation}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InteractiveScene({ scene }: { scene: CourseScene }) {
  const [complexity, setComplexity] = useState(45);
  const [focus, setFocus] = useState(62);
  return (
    <div className="grid h-full gap-5 lg:grid-cols-[1fr_18rem]">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-sky-200/70">
          {scene.interactive?.kind === 'mindmap' ? 'Mind Map' : 'Deep Interactive Mode'}
        </div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.interactive?.prompt || scene.description}</p>

        <div className="mt-6 rounded-[1.75rem] border border-white/10 bg-slate-950/70 p-6">
          <div className="relative h-80 overflow-hidden rounded-[1.25rem] bg-gradient-to-br from-sky-500/20 via-teal-500/10 to-slate-950">
            <div className="absolute left-[12%] top-[18%] h-24 w-24 rounded-full border border-sky-300/50 bg-sky-300/10" />
            <div
              className="absolute rounded-full border border-teal-300/70 bg-teal-300/20 transition-all duration-500"
              style={{
                left: `${complexity}%`,
                top: `${100 - focus}%`,
                width: `${72 + complexity}px`,
                height: `${72 + complexity}px`,
              }}
            />
            <div className="absolute bottom-5 left-5 right-5 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-slate-200 backdrop-blur">
              教师正在操作交互 UI：调节复杂度与关注点，观察概念之间的动态关系。
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <ControlSlider label="复杂度" value={complexity} onChange={setComplexity} />
        <ControlSlider label="关注点" value={focus} onChange={setFocus} />
        <div className="space-y-2">
          {scene.interactive?.controls.map(control => (
            <button
              key={control}
              type="button"
              className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm hover:bg-white/10"
            >
              {control}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ControlSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-sm text-slate-300">
      <span className="mb-2 flex justify-between">
        {label}
        <span>{value}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="w-full accent-teal-300"
      />
    </label>
  );
}

function CodeScene({
  scene,
  codeDraft,
  output,
  onCodeDraftChange,
  onRunCode,
}: {
  scene: CourseScene;
  codeDraft: string;
  output: string;
  onCodeDraftChange: (value: string) => void;
  onRunCode: () => void;
}) {
  return (
    <div className="grid h-full gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="flex min-h-0 flex-col">
        <div className="text-xs uppercase tracking-[0.3em] text-lime-200/70">Online Programming</div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <textarea
          value={codeDraft}
          onChange={event => onCodeDraftChange(event.target.value)}
          className="mt-5 min-h-80 flex-1 resize-none rounded-[1.5rem] border border-white/10 bg-slate-950 p-5 font-mono text-sm text-lime-100 outline-none focus:border-lime-300/60"
        />
      </div>
      <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <button
          type="button"
          onClick={onRunCode}
          className="w-full rounded-2xl bg-lime-300 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-lime-200"
        >
          运行示例
        </button>
        <div className="mt-4 rounded-2xl bg-black/40 p-4 font-mono text-sm text-lime-100">
          Output: {output}
        </div>
        <p className="mt-4 text-sm leading-relaxed text-slate-300">
          这里提供与 OpenMAIC 在线编程相同的学习路径：先读概念，再改变量，最后运行验证。
        </p>
      </div>
    </div>
  );
}

function PblScene({
  scene,
  selectedRole,
  onRoleSelect,
}: {
  scene: CourseScene;
  selectedRole: string | null;
  onRoleSelect: (role: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.3em] text-fuchsia-200/70">
          Project-Based Learning
        </div>
        <h2 className="mt-3 text-3xl font-semibold">{scene.title}</h2>
        <p className="mt-2 text-slate-300">{scene.pbl?.challenge}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {scene.pbl?.roles.map(role => (
          <button
            key={role}
            type="button"
            onClick={() => onRoleSelect(role)}
            className={`rounded-[1.25rem] border p-5 text-left ${
              selectedRole === role
                ? 'border-fuchsia-300 bg-fuchsia-300/15'
                : 'border-white/10 bg-white/[0.04] hover:bg-white/10'
            }`}
          >
            <div className="text-lg font-semibold">{role}</div>
            <p className="mt-2 text-sm text-slate-400">选择后进入协作任务。</p>
          </button>
        ))}
      </div>
      <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5">
        <h3 className="mb-4 font-semibold">里程碑</h3>
        <div className="grid gap-3 md:grid-cols-4">
          {scene.pbl?.milestones.map((milestone, index) => (
            <div key={milestone} className="rounded-2xl bg-black/30 p-4">
              <div className="mb-2 text-xs text-slate-500">Step {index + 1}</div>
              {milestone}
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-2xl border border-fuchsia-300/30 bg-fuchsia-300/10 p-4 text-sm">
          交付物: {scene.pbl?.deliverable}
        </div>
      </div>
    </div>
  );
}

function ActionTimeline({ scene, effect }: { scene: CourseScene; effect: StageEffect | null }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-black/25 p-4">
      <div className="mb-3 text-xs uppercase tracking-[0.25em] text-slate-400">Action Engine</div>
      <div className="space-y-2">
        {scene.actions.map(action => {
          const active = effect && action.type.includes(effect.kind);
          return (
            <div
              key={action.id}
              className={`rounded-2xl border p-3 text-sm ${
                active ? 'border-teal-300/50 bg-teal-300/10' : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{action.type}</div>
              <div className="mt-1 font-medium">{action.title}</div>
              {action.content && <div className="mt-1 line-clamp-2 text-xs text-slate-400">{action.content}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Whiteboard({ scene, utterance }: { scene: CourseScene; utterance?: Utterance }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-slate-100 p-4 text-slate-950 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
          Whiteboard
        </div>
        <div className="h-2 w-2 rounded-full bg-red-500" />
      </div>
      <svg viewBox="0 0 300 160" className="mb-3 h-36 w-full rounded-xl bg-white">
        <path d="M30 120 C80 40 125 80 160 30 S235 65 270 25" fill="none" stroke="#14b8a6" strokeWidth="4" />
        <line x1="40" y1="130" x2="260" y2="130" stroke="#94a3b8" strokeDasharray="6 6" />
        <circle cx="160" cy="30" r="8" fill="#0f766e" />
      </svg>
      <div className="space-y-2 text-sm">
        {scene.key_points.slice(0, 3).map(point => (
          <div key={point} className="rounded-xl bg-slate-100 p-2 shadow-sm">
            {point}
          </div>
        ))}
        {utterance && (
          <div className="rounded-xl bg-teal-50 p-2 text-teal-950">
            最新发言: {utterance.content.slice(0, 80)}
          </div>
        )}
      </div>
    </div>
  );
}

interface ClassroomChatProps {
  utterances: Utterance[];
  mode: ClassroomMode;
  input: string;
  deferredInput: string;
  sending: boolean;
  activeQuestions: string[];
  roles: AgentRole[];
  latestSpeaker?: SpeakerRole;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onModeChange: (mode: ClassroomMode) => void;
  onQuickAsk: (question: string) => void;
}

const ClassroomChat = React.forwardRef<HTMLDivElement, ClassroomChatProps>(function ClassroomChat(
  {
    utterances,
    mode,
    input,
    deferredInput,
    sending,
    activeQuestions,
    roles,
    latestSpeaker,
    onInputChange,
    onSend,
    onModeChange,
    onQuickAsk,
  },
  ref
) {
  return (
    <aside className="flex min-h-0 flex-col rounded-[1.75rem] border border-white/10 bg-black/25">
      <div className="border-b border-white/10 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-slate-500">Roundtable</div>
            <h2 className="font-semibold">多智能体讨论</h2>
          </div>
          <div className="flex rounded-full border border-white/10 p-1 text-xs">
            <button
              type="button"
              onClick={() => onModeChange('continuous')}
              className={`rounded-full px-3 py-1 ${mode === 'continuous' ? 'bg-teal-300 text-slate-950' : 'text-slate-400'}`}
            >
              连续
            </button>
            <button
              type="button"
              onClick={() => onModeChange('interactive')}
              className={`rounded-full px-3 py-1 ${mode === 'interactive' ? 'bg-teal-300 text-slate-950' : 'text-slate-400'}`}
            >
              交互
            </button>
          </div>
        </div>
        <div className="flex -space-x-2">
          {roles.map(role => (
            <AgentBadge key={role} role={role} active={latestSpeaker === role} />
          ))}
        </div>
      </div>

      <div ref={ref} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {utterances.map(utterance => (
          <ChatBubble key={utterance.id} utterance={utterance} />
        ))}
        {utterances.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
            课堂即将开始，老师和同学会在这里实时发言。
          </div>
        )}
      </div>

      <div className="border-t border-white/10 p-4">
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {activeQuestions.slice(0, 3).map(question => (
            <button
              key={question}
              type="button"
              onClick={() => onQuickAsk(question)}
              className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
            >
              {question}
            </button>
          ))}
        </div>
        <textarea
          value={input}
          onChange={event => onInputChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void onSend();
            }
          }}
          rows={3}
          placeholder="随时打断、提问，或请求换一种讲法..."
          className="w-full resize-none rounded-2xl border border-white/10 bg-slate-950/80 p-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-teal-300/60"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500">
            {deferredInput.trim().length} 字 · Enter 发送
          </div>
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={sending || !input.trim()}
            className="rounded-2xl bg-teal-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-200 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  );
});

function AgentBadge({ role, active }: { role: AgentRole; active: boolean }) {
  const meta = ROLE_META[role];
  return (
    <div
      title={meta.name}
      className={`grid h-10 w-10 place-items-center rounded-full border-2 border-slate-950 bg-gradient-to-br ${meta.tone} text-xs font-bold text-slate-950 ${
        active ? 'ring-2 ring-teal-200' : ''
      }`}
    >
      {meta.initials}
    </div>
  );
}

function ChatBubble({ utterance }: { utterance: Utterance }) {
  const role = utterance.speaker as SpeakerRole;
  const meta = ROLE_META[role] ?? ROLE_META.student;
  const isStudent = role === 'student';
  return (
    <div className={`flex gap-3 ${isStudent ? 'flex-row-reverse' : ''}`}>
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br ${meta.tone} text-xs font-bold text-slate-950`}>
        {meta.initials}
      </div>
      <div
        className={`max-w-[82%] rounded-2xl border px-3 py-2 text-sm ${
          isStudent
            ? 'border-lime-300/30 bg-lime-300/10'
            : 'border-white/10 bg-white/[0.05]'
        }`}
      >
        <div className="mb-1 text-xs font-semibold text-slate-300">
          {utterance.speaker_name || meta.name}
        </div>
        <div className="whitespace-pre-wrap leading-relaxed text-slate-100">{utterance.content}</div>
      </div>
    </div>
  );
}

function deriveScenes(course: Course | null): CourseScene[] {
  const prepared = course?.prepared;
  if (!prepared) return [];
  if (Array.isArray(prepared.scenes) && prepared.scenes.length > 0) return prepared.scenes;
  const pages = prepared.pages ?? [];
  const fallbackScenes: CourseScene[] = pages.map((page, index) => ({
    id: `fallback_slide_${page.index}`,
    order: index,
    type: 'slide',
    title: page.key_points[0] || `第 ${page.index + 1} 页`,
    description: page.description || page.raw_text.slice(0, 200),
    page_refs: [page.index],
    key_points: page.key_points,
    actions: [
      {
        id: `fallback_speech_${page.index}`,
        type: 'speech',
        title: '教师讲解',
        content: page.description,
      },
      {
        id: `fallback_discussion_${page.index}`,
        type: 'discussion',
        title: '课堂讨论',
        content: prepared.active_questions[index % Math.max(prepared.active_questions.length, 1)],
      },
    ],
  }));
  if (prepared.active_questions.length > 0) {
    fallbackScenes.push({
      id: 'fallback_quiz',
      order: fallbackScenes.length,
      type: 'quiz',
      title: '即时测验',
      description: '基于课程主动提问生成的检查点。',
      page_refs: [0],
      key_points: [],
      actions: [],
      quiz: [
        {
          id: 'fallback_quiz_1',
          question: prepared.active_questions[0],
          options: ['围绕核心概念回答', '跳过细节', '只背结论', '不需要联系例子'],
          answer_index: 0,
          explanation: 'OpenMAIC 课堂强调理解概念关系与迁移应用。',
        },
      ],
    });
  }
  return fallbackScenes;
}

function appendUtterance(existing: Utterance[], utterance: Utterance): Utterance[] {
  if (existing.some(item => item.id === utterance.id)) return existing;
  return [...existing, utterance];
}

function mergeUtterances(existing: Utterance[], incoming: Utterance[]): Utterance[] {
  const byId = new Map(existing.map(item => [item.id, item]));
  for (const utterance of incoming) byId.set(utterance.id, utterance);
  return Array.from(byId.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function makeSystemUtterance(message: string): Utterance {
  return {
    id: `system_${Date.now()}`,
    speaker: 'ta',
    speaker_name: '系统提示',
    content: message,
    timestamp: new Date().toISOString(),
  };
}

function toStageEffect(action: TeachingAction | undefined): StageEffect | null {
  if (!action) return null;
  switch (action.type) {
    case 'ShowFile':
      return { kind: 'spotlight', label: '切换课件' };
    case 'ReadScript':
      return { kind: 'laser', label: '讲解重点' };
    case 'AskQuestion':
      return { kind: 'discussion', label: '主动提问' };
    case 'AnswerStudent':
      return { kind: 'spotlight', label: '回答学生' };
    default:
      return null;
  }
}

function mostlyChinese(text: string): boolean {
  if (!text) return true;
  const matches = text.match(/[\u4e00-\u9fff]/g);
  return (matches?.length ?? 0) / text.length > 0.25;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
