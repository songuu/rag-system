'use client';

import React from 'react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface ToastProps {
  toasts: Toast[];
}

export default function Toast({ toasts }: ToastProps) {
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {toasts.map((toast) => {
        const colors = {
          success: 'bg-green-500',
          error: 'bg-red-500',
          warning: 'bg-yellow-500',
          info: 'bg-blue-500'
        };
        return (
          <div
            key={toast.id + toast.message + toast.type}
            className={`${colors[toast.type]} text-white px-4 py-2 rounded-lg shadow-lg flex items-center space-x-2 animate-slide-in`}
          >
            <span className="text-sm">{toast.message}</span>
          </div>
        );
      })}
    </div>
  );
}