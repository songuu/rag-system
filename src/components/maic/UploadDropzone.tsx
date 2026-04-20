'use client';

import React, { useState, useRef } from 'react';

interface Props {
  onUploaded: (courseId: string) => void;
}

export function UploadDropzone({ onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', file.name.replace(/\.[^.]+$/, ''));
      const resp = await fetch('/api/maic/upload', { method: 'POST', body: fd });
      const json = await resp.json();
      if (!json.success) throw new Error(json.error || 'upload failed');
      onUploaded(json.data.course_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
      <div className="mb-3 text-4xl">📚</div>
      <div className="mb-2 text-lg font-medium">上传课程资料</div>
      <div className="mb-4 text-sm text-slate-400">
        支持 PDF / Markdown / TXT / Word。系统会自动解析、生成知识树与讲课脚本。
      </div>
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="rounded-full bg-emerald-500 px-6 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {uploading ? '上传中…' : '选择文件'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.md,.markdown,.txt,.docx,.doc,.json"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      {error && <div className="mt-3 text-sm text-rose-400">{error}</div>}
    </div>
  );
}
