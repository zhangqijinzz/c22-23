import type { AnalysisCheckpoint, AnalysisProgress } from '../domain/ruleAnalysis';
import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import RuleCheckWorker from './ruleCheck.worker?worker';

export interface CheckOperation {
  promise: Promise<RuleAnalysis>;
  cancel: () => void;
}

export interface RunCheckOptions {
  /** 从上次取消的断点继续计算；缺省时从头完整枚举。 */
  resumeFrom?: AnalysisCheckpoint;
  /** 进度回调，Worker 内部已按 progressIntervalMs 节流。 */
  onProgress?: (progress: AnalysisProgress) => void;
  /** 取消生效时回调，携带可续算的断点。 */
  onCheckpoint?: (checkpoint: AnalysisCheckpoint) => void;
  /** 进度上报的最小间隔（毫秒），默认 120ms。 */
  progressIntervalMs?: number;
}

interface WorkerResponse {
  requestId: number;
  type?: 'progress' | 'result' | 'cancelled' | 'error';
  analysis?: RuleAnalysis;
  progress?: AnalysisProgress;
  checkpoint?: AnalysisCheckpoint;
  error?: string;
}

const CANCEL_FALLBACK_MS = 800;

export class RuleCheckService {
  private nextRequestId = 1;

  run(project: RuleProject, options: RunCheckOptions = {}): CheckOperation {
    const worker = new RuleCheckWorker();
    const requestId = this.nextRequestId++;
    let settled = false;
    let cancelRequested = false;
    let rejectPending: (reason: Error) => void = () => undefined;
    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      rejectPending = reject;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.requestId !== requestId) return;
        if (event.data.type === 'progress') {
          if (event.data.progress) options.onProgress?.(event.data.progress);
          return;
        }
        settled = true;
        worker.terminate();
        if (event.data.type === 'cancelled') {
          if (event.data.checkpoint) options.onCheckpoint?.(event.data.checkpoint);
          reject(new DOMException('规则检查已取消', 'AbortError'));
        } else if (event.data.analysis) {
          resolve(event.data.analysis);
        } else {
          reject(new Error(event.data.error ?? '规则分析失败'));
        }
      };
      worker.onerror = (event) => {
        settled = true;
        worker.terminate();
        reject(new Error(event.message || '规则检查 Worker 运行失败'));
      };
      worker.postMessage({
        type: 'start',
        requestId,
        project,
        resumeFrom: options.resumeFrom,
        progressIntervalMs: options.progressIntervalMs,
      });
    });
    return {
      promise,
      cancel: () => {
        if (settled || cancelRequested) return;
        cancelRequested = true;
        // 协作式取消：Worker 在分片边界响应并回传断点
        worker.postMessage({ type: 'cancel', requestId });
        // 兜底：Worker 异常无响应时直接终止，避免界面卡在检查中
        setTimeout(() => {
          if (settled) return;
          settled = true;
          worker.terminate();
          rejectPending(new DOMException('规则检查已取消', 'AbortError'));
        }, CANCEL_FALLBACK_MS);
      },
    };
  }
}
