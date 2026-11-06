'use client';

import { useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

const MIN_HEIGHT = 280;
const KEYBOARD_STEP = 32;

function subscribeToViewport(onResize: () => void) {
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}

function getViewportHeight() {
  return window.innerHeight;
}

function getServerViewportHeight() {
  return 900;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export default function ResizableChatArea({ children }: { children: ReactNode }) {
  const viewportHeight = useSyncExternalStore(subscribeToViewport, getViewportHeight, getServerViewportHeight);
  const maxHeight = Math.max(360, Math.round(viewportHeight * 0.85));
  const defaultHeight = clamp(Math.round(viewportHeight * 0.56), 360, 760);
  const [customHeight, setCustomHeight] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const height = clamp(customHeight ?? defaultHeight, MIN_HEIGHT, maxHeight);
  const areaId = useId();
  const hintId = useId();
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  function startDragging(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      // Use the rendered size so the first movement stays smooth at any zoom level.
      startHeight: areaRef.current?.getBoundingClientRect().height || height,
    };
    setIsDragging(true);
  }

  function resizeFromPointer(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setCustomHeight(clamp(drag.startHeight + event.clientY - drag.startY, MIN_HEIGHT, maxHeight));
  }

  function stopDragging(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    let nextHeight: number | null;
    switch (event.key) {
      case 'ArrowUp': nextHeight = height - KEYBOARD_STEP; break;
      case 'ArrowDown': nextHeight = height + KEYBOARD_STEP; break;
      case 'Home': nextHeight = MIN_HEIGHT; break;
      case 'End': nextHeight = maxHeight; break;
      case 'Enter': nextHeight = null; break;
      default: return;
    }
    event.preventDefault();
    setCustomHeight(nextHeight === null ? null : clamp(nextHeight, MIN_HEIGHT, maxHeight));
  }

  return (
    <div className={isDragging ? 'select-none' : undefined}>
      <div
        id={areaId}
        ref={areaRef}
        role="region"
        aria-label="对话消息"
        tabIndex={0}
        className="min-w-0 overflow-y-auto overscroll-contain p-4 space-y-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:p-6"
        style={{ height: customHeight === null ? 'clamp(360px, 56dvh, 760px)' : height }}
      >
        {children}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label="调整对话区域高度"
        aria-orientation="horizontal"
        aria-controls={areaId}
        aria-describedby={hintId}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        aria-valuetext={`${height} 像素`}
        title="上下拖动调整高度；双击或按 Enter 还原；方向键微调"
        className={`group flex h-8 touch-none cursor-row-resize select-none items-center justify-center gap-2 border-t border-gray-200 text-xs outline-none transition-colors hover:bg-blue-50 hover:text-blue-600 focus-visible:bg-blue-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${isDragging ? 'bg-blue-50 text-blue-600' : 'bg-gray-50/80 text-gray-500'}`}
        onPointerDown={startDragging}
        onPointerMove={resizeFromPointer}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={stopDragging}
        onDoubleClick={() => setCustomHeight(null)}
        onKeyDown={resizeFromKeyboard}
      >
        <span aria-hidden="true" className="flex w-5 flex-col gap-1">
          <span className="h-0.5 rounded-full bg-current" />
          <span className="h-0.5 rounded-full bg-current" />
        </span>
        <span id={hintId}>上下拖动调整高度 · 双击还原</span>
      </div>
    </div>
  );
}
