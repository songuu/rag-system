import type { ReactNode } from 'react';
import { MiroFishLanguageSwitcher, MiroFishLocaleProvider } from '@/components/mirofish/MiroFishLocaleProvider';

export default function MiroFishLayout({ children }: { children: ReactNode }) {
  return <MiroFishLocaleProvider>
    <div className="flex justify-end border-b border-white/10 bg-slate-950 px-6 py-2"><MiroFishLanguageSwitcher /></div>
    {children}
  </MiroFishLocaleProvider>;
}
