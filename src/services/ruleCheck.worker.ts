import type { RuleProject } from '../models/ruleModel';
import {
  AnalysisRunner,
  PROGRESS_THROTTLE_MS,
  computeProjectSignature,
  type AnalysisCheckpoint,
  type AnalysisProgress,
} from '../domain/ruleAnalysis';
import { CheckpointStore } from './checkpointStore';
import type { CheckWorkerRequest, CheckWorkerResponse } from './checkWorkerProtocol';

interface ActiveRun {
  requestId: number;
  runner: AnalysisRunner;
  cancelled: boolean;
  /** 上一次发送进度的时间，用于节流。 */
  lastEmitAt: number;
}

let activeRun: ActiveRun | null = null;

self.onmessage = (event: MessageEvent<CheckWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (activeRun?.requestId === message.requestId) activeRun.cancelled = true;
    return;
  }
  if (message.type === 'start') void startRun(message.requestId, message.project);
};

async function startRun(requestId: number, project: RuleProject): Promise<void> {
  const signature = computeProjectSignature(project);
  let checkpoint: AnalysisCheckpoint | null = null;
  try {
    checkpoint = await CheckpointStore.get(signature);
  } catch {
    // 检查点不可用时退化为从头计算，不影响结论。
    checkpoint = null;
  }

  const runner = new AnalysisRunner(project, checkpoint);
  const run: ActiveRun = { requestId, runner, cancelled: false, lastEmitAt: 0 };
  activeRun = run;

  const emitProgress = (): void => {
    if (run.cancelled) return;
    const progress: AnalysisProgress = runner.getProgress();
    self.postMessage({ type: 'progress', requestId, progress } satisfies CheckWorkerResponse);
  };

  const persistCheckpoint = (): void => {
    // 检查点与进度同节奏落盘，取消后最多丢失一个节流周期内的进度。
    CheckpointStore.put(signature, runner.checkpoint()).catch(() => undefined);
  };

  try {
    // 立刻广播一次：总量、当前维度，以及是否续算，避免开头几百毫秒只有转圈。
    emitProgress();
    run.lastEmitAt = performance.now();
    while (!runner.isDone) {
      await runner.runChunk();
      if (run.cancelled) break;
      const now = performance.now();
      if (now - run.lastEmitAt >= PROGRESS_THROTTLE_MS) {
        emitProgress();
        run.lastEmitAt = now;
        persistCheckpoint();
      }
    }

    if (run.cancelled) {
      // 协作式收尾：把当前检查点落盘后再通知主线程，保证“取消后接着算”真的能续上。
      await CheckpointStore.put(signature, runner.checkpoint()).catch(() => undefined);
      if (activeRun === run) activeRun = null;
      self.postMessage({ type: 'cancelled', requestId } satisfies CheckWorkerResponse);
      return;
    }

    const analysis = runner.result();
    // 结论已产出，删除检查点：下次运行应得到一次跑完的全新归约。
    await CheckpointStore.delete(signature).catch(() => undefined);
    if (activeRun === run) activeRun = null;
    self.postMessage({ type: 'done', requestId, analysis } satisfies CheckWorkerResponse);
  } catch (error) {
    if (activeRun === run) activeRun = null;
    self.postMessage({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : '规则分析失败',
    } satisfies CheckWorkerResponse);
  }
}
