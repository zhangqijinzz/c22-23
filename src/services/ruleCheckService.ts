import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import type { AnalysisProgress } from '../domain/ruleAnalysis';
import RuleCheckWorker from './ruleCheck.worker?worker';
import type { CheckWorkerResponse } from './checkWorkerProtocol';

export interface CheckOperation {
  promise: Promise<RuleAnalysis>;
  cancel: () => void;
  onProgress: (listener: (progress: AnalysisProgress) => void) => void;
}

export class RuleCheckService {
  private nextRequestId = 1;

  run(project: RuleProject): CheckOperation {
    const worker = new RuleCheckWorker();
    const requestId = this.nextRequestId++;
    let rejectPending: (reason: Error) => void = () => undefined;
    let settled = false;
    const progressListeners = new Set<(progress: AnalysisProgress) => void>();

    const promise = new Promise<RuleAnalysis>((resolve, reject) => {
      rejectPending = reject;
      worker.onmessage = (event: MessageEvent<CheckWorkerResponse>) => {
        const message = event.data;
        if (message.requestId !== requestId) return;
        if (message.type === 'progress') {
          progressListeners.forEach((listener) => listener(message.progress));
          return;
        }
        // done / cancelled / error 都是终态。
        settled = true;
        worker.terminate();
        if (message.type === 'done') resolve(message.analysis);
        else if (message.type === 'cancelled') reject(new DOMException('规则检查已取消', 'AbortError'));
        else reject(new Error(message.error || '规则分析失败'));
      };
      worker.onerror = (event) => {
        settled = true;
        worker.terminate();
        reject(new Error(event.message || '规则检查 Worker 运行失败'));
      };
      worker.postMessage({ type: 'start', requestId, project });
    });

    return {
      promise,
      onProgress: (listener) => {
        progressListeners.add(listener);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        // 不立即 terminate：通知 worker 协作式收尾，把当前检查点落盘；终态消息回来后再回收 worker。
        worker.postMessage({ type: 'cancel', requestId });
        rejectPending(new DOMException('规则检查已取消', 'AbortError'));
      },
    };
  }
}
