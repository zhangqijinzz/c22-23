import type { RuleAnalysis, RuleProject } from '../models/ruleModel';
import type { AnalysisProgress } from '../domain/ruleAnalysis';

/** 主线程 → Worker */
export type CheckWorkerRequest =
  | { type: 'start'; requestId: number; project: RuleProject }
  | { type: 'cancel'; requestId: number };

/** Worker → 主线程（检查点只在 worker 内落盘，不经过消息传递） */
export type CheckWorkerResponse =
  | { type: 'progress'; requestId: number; progress: AnalysisProgress }
  | { type: 'done'; requestId: number; analysis: RuleAnalysis }
  | { type: 'cancelled'; requestId: number }
  | { type: 'error'; requestId: number; error: string };
