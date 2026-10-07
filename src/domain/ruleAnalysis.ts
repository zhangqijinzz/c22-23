import type {
  MatchWitness,
  RuleAnalysis,
  RuleCondition,
  RuleField,
  RuleOverlap,
  RuleProject,
  SampleInput,
} from '../models/ruleModel';
import { matchesRule } from './conditionEvaluator';

const MAX_CASES = 120_000;
const MAX_EXAMPLES = 4;

/** 取消时保存的断点：包含继续枚举所需的全部累加器，恢复后与一次跑完的结果完全一致。 */
export interface AnalysisCheckpoint {
  path: number[];
  checkedCases: number;
  coveredCases: number;
  seenRuleIds: string[];
  visibleRuleIds: string[];
  processedMatchSets: string[];
  overlaps: RuleOverlap[];
  uncoveredExamples: SampleInput[];
  truncated: boolean;
  done: boolean;
}

export interface AnalysisProgress {
  checkedCases: number;
  totalCases: number;
  plannedCases: number;
  percent: number;
  truncated: boolean;
  currentValues: SampleInput;
}

export interface AnalysisSession {
  /** 处理一个时间预算内的若干组合，返回是否已全部完成。 */
  step(budgetMs: number): boolean;
  progress(): AnalysisProgress;
  checkpoint(): AnalysisCheckpoint;
  result(): RuleAnalysis;
  readonly done: boolean;
}

const overlapKey = (ruleAId: string, ruleBId: string): string => [ruleAId, ruleBId].sort().join('|');

export function createAnalysisSession(project: RuleProject, resumeFrom?: AnalysisCheckpoint): AnalysisSession {
  const candidates = project.fields.map((field) => valuesForField(field, project));
  const ordered = [...project.rules].sort((a, b) => b.priority - a.priority || project.rules.indexOf(a) - project.rules.indexOf(b));
  const totalCases = candidates.reduce((total, values) => total * values.length, 1);
  const plannedCases = Math.min(totalCases, MAX_CASES);

  const overlaps = new Map<string, RuleOverlap>();
  const seen = new Set<string>();
  const visible = new Set<string>();
  const processedMatchSets = new Set<string>();
  const state = {
    path: project.fields.map(() => 0),
    checkedCases: 0,
    coveredCases: 0,
    uncoveredExamples: [] as SampleInput[],
    truncated: false,
    done: candidates.some((values) => values.length === 0),
    currentValues: {} as SampleInput,
  };

  if (resumeFrom && resumeFrom.path.length === project.fields.length) {
    state.path = [...resumeFrom.path];
    state.checkedCases = resumeFrom.checkedCases;
    state.coveredCases = resumeFrom.coveredCases;
    state.uncoveredExamples = resumeFrom.uncoveredExamples.map((example) => ({ ...example }));
    state.truncated = resumeFrom.truncated;
    state.done = resumeFrom.done;
    resumeFrom.seenRuleIds.forEach((id) => seen.add(id));
    resumeFrom.visibleRuleIds.forEach((id) => visible.add(id));
    resumeFrom.processedMatchSets.forEach((key) => processedMatchSets.add(key));
    resumeFrom.overlaps.forEach((overlap) => overlaps.set(overlapKey(overlap.ruleAId, overlap.ruleBId), { ...overlap, witness: { ...overlap.witness } }));
  }

  const processCurrent = (): void => {
    const values: SampleInput = {};
    for (let index = 0; index < project.fields.length; index += 1) {
      values[project.fields[index].id] = candidates[index][state.path[index]];
    }
    state.currentValues = values;
    state.checkedCases += 1;
    const matched = ordered.filter((rule) => matchesRule(rule, values));
    for (const rule of matched) seen.add(rule.id);
    if (matched.length) state.coveredCases += 1;
    else if (state.uncoveredExamples.length < MAX_EXAMPLES) state.uncoveredExamples.push({ ...values });
    if (matched[0]) visible.add(matched[0].id);
    const matchSetKey = matched.length > 1 ? matched.map((rule) => rule.id).sort().join('|') : '';
    if (matched.length > 1 && !processedMatchSets.has(matchSetKey)) {
      processedMatchSets.add(matchSetKey);
      for (let left = 0; left < matched.length; left += 1) {
        for (let right = left + 1; right < matched.length; right += 1) {
          const ruleA = matched[left];
          const ruleB = matched[right];
          const key = overlapKey(ruleA.id, ruleB.id);
          if (!overlaps.has(key)) {
            overlaps.set(key, {
              ruleAId: ruleA.id,
              ruleBId: ruleB.id,
              conflict: ruleA.priority === ruleB.priority && ruleA.result !== ruleB.result,
              witness: { ...values },
            });
          }
        }
      }
    }
  };

  const advance = (): boolean => {
    for (let index = state.path.length - 1; index >= 0; index -= 1) {
      if (state.path[index] + 1 < candidates[index].length) {
        state.path[index] += 1;
        return true;
      }
      state.path[index] = 0;
    }
    return false;
  };

  return {
    get done() {
      return state.done;
    },
    step(budgetMs: number): boolean {
      if (state.done) return true;
      const deadline = performance.now() + Math.max(0, budgetMs);
      do {
        if (state.checkedCases >= MAX_CASES) {
          state.truncated = true;
          state.done = true;
          break;
        }
        processCurrent();
        if (!advance()) {
          state.done = true;
          break;
        }
      } while (performance.now() < deadline);
      return state.done;
    },
    progress(): AnalysisProgress {
      const percent = plannedCases > 0 ? Math.min(100, Math.floor((state.checkedCases / plannedCases) * 100)) : 100;
      return {
        checkedCases: state.checkedCases,
        totalCases,
        plannedCases,
        percent,
        truncated: state.truncated,
        currentValues: { ...state.currentValues },
      };
    },
    checkpoint(): AnalysisCheckpoint {
      return {
        path: [...state.path],
        checkedCases: state.checkedCases,
        coveredCases: state.coveredCases,
        seenRuleIds: [...seen],
        visibleRuleIds: [...visible],
        processedMatchSets: [...processedMatchSets],
        overlaps: [...overlaps.values()].map((overlap) => ({ ...overlap, witness: { ...overlap.witness } })),
        uncoveredExamples: state.uncoveredExamples.map((example) => ({ ...example })),
        truncated: state.truncated,
        done: state.done,
      };
    },
    result(): RuleAnalysis {
      const unreachableRuleIds = project.rules.filter((rule) => !seen.has(rule.id)).map((rule) => rule.id);
      const shadowedRuleIds = project.rules.filter((rule) => seen.has(rule.id) && !visible.has(rule.id)).map((rule) => rule.id);
      return {
        checkedCases: state.checkedCases,
        coveredCases: state.coveredCases,
        coveragePercent: state.checkedCases ? Math.round((state.coveredCases / state.checkedCases) * 100) : 0,
        overlaps: [...overlaps.values()],
        unreachableRuleIds,
        shadowedRuleIds,
        uncoveredExamples: state.uncoveredExamples,
        truncated: state.truncated,
      };
    },
  };
}

export function analyzeRules(project: RuleProject): RuleAnalysis {
  const session = createAnalysisSession(project);
  while (!session.step(Number.POSITIVE_INFINITY)) {
    // 同步一次跑完，直到枚举结束
  }
  return session.result();
}

type ScalarCandidate = string | number | boolean;

function valuesForField(field: RuleField, project: RuleProject): ScalarCandidate[] {
  if (field.type === 'boolean') return [false, true];
  if (field.type === 'enum') return field.enumValues ?? [];
  const min = field.min ?? 0;
  const max = field.max ?? min;
  const breaks = new Set<number>([min, max]);
  for (const rule of project.rules) collectBreaks(rule.conditions, field.id, min, max, breaks);
  const sorted = [...breaks].sort((a, b) => a - b);
  const values = new Set<number>(sorted);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    values.add(sorted[index] + (sorted[index + 1] - sorted[index]) / 2);
  }
  return [...values].sort((a, b) => a - b);
}

function collectBreaks(
  condition: RuleCondition,
  fieldId: string,
  min: number,
  max: number,
  breaks: Set<number>,
): void {
  if (condition.kind === 'group') {
    condition.conditions.forEach((child) => collectBreaks(child, fieldId, min, max, breaks));
    return;
  }
  if (condition.fieldId !== fieldId) return;
  let boundaries: number[];
  if (typeof condition.value === 'number') boundaries = [condition.value];
  else if (typeof condition.value === 'object' && condition.value !== null && 'min' in condition.value && 'max' in condition.value) boundaries = [condition.value.min, condition.value.max];
  else return;
  for (const value of boundaries) if (value >= min && value <= max) breaks.add(value);
}

export const ruleAnalysisService = { analyze: analyzeRules };

export function firstOverlapWitness(analysis: RuleAnalysis): MatchWitness | undefined {
  const overlap = analysis.overlaps[0];
  return overlap ? { values: overlap.witness, ruleIds: [overlap.ruleAId, overlap.ruleBId] } : undefined;
}
