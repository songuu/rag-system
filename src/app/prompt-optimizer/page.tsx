import type { Metadata } from 'next';
import PromptOptimizerStudio from '@/components/prompt-optimizer/PromptOptimizerStudio';
import styles from './page.module.css';

export const metadata: Metadata = { title: '提示词优化台', description: '可追溯、可比较、独立模型配置的提示词优化工作台' };

export default function PromptOptimizerPage() {
  return <main className={styles.page}><PromptOptimizerStudio /></main>;
}
