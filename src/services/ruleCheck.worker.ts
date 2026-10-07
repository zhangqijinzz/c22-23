import type { AnalysisCheckpoint } from '../domain/ruleAnalysis';
import { createAnalysisSession } from '../domain/ruleAnalysis';
import type { RuleProject } from '../models/ruleModel';

interface StartMessage {
  type: 'start';
  requestId: number;
  project: RuleProject;
  resumeFrom?: AnalysisCheckpoint;
  progressIntervalMs?: number;
  chunkBudgetMs?: number;
}

interface CancelMessage {
  type: 'cancel';
  requestId: number;
}

type WorkerRequest = StartMessage | CancelMessage;

const DEFAULT_PROGRESS_INTERVAL_MS = 120;
const DEFAULT_CHUNK_BUDGET_MS = 24;
const MIN_PROGRESS_INTERVAL_MS = 16;

let active: { requestId: number; cancelled: boolean } | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (active && active.requestId === message.requestId) active.cancelled = true;
    return;
  }
  if (message.type === 'start') startRun(message);
};

function startRun(message: StartMessage): void {
  const session = createAnalysisSession(message.project, message.resumeFrom);
  const state = { requestId: message.requestId, cancelled: false };
  active = state;
  // 进度上报按最小间隔节流，避免频繁 postMessage 拖慢枚举
  const progressInterval = Math.max(MIN_PROGRESS_INTERVAL_MS, message.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const chunkBudget = Math.max(1, message.chunkBudgetMs ?? DEFAULT_CHUNK_BUDGET_MS);
  let lastProgressAt = 0;

  const pump = (): void => {
    if (state.cancelled) {
      active = null;
      self.postMessage({ type: 'cancelled', requestId: state.requestId, checkpoint: session.checkpoint() });
      return;
    }
    try {
      const done = session.step(chunkBudget);
      const now = performance.now();
      if (!done && now - lastProgressAt >= progressInterval) {
        lastProgressAt = now;
        self.postMessage({ type: 'progress', requestId: state.requestId, progress: session.progress() });
      }
      if (done) {
        active = null;
        self.postMessage({ type: 'result', requestId: state.requestId, analysis: session.result() });
        return;
      }
      setTimeout(pump, 0);
    } catch (error) {
      active = null;
      self.postMessage({
        type: 'error',
        requestId: state.requestId,
        error: error instanceof Error ? error.message : '规则分析失败',
      });
    }
  };
  pump();
}
