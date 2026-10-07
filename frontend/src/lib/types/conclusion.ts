/**
 * 漂移结论快照（音准账的「结论」）。
 *
 * 结论不是实时的，而是「某一时刻、基于当时数据算出并确认」的快照：
 * - 环境记录一改动，待复核结论立即失效（stale），趋势与建议重算；
 * - 已确认过的旧结论永久留在历史里；
 * - 没复核前，周期提醒与导出照旧使用最近一条「已确认」结论。
 */
import type { DriftSpeedLevel } from '$lib/utils/drift';

/** 结论复核状态 */
export type ConclusionStatus = '待复核' | '已确认' | '已失效';

/** 结论快照（持久化到 conclusions 表） */
export interface DriftConclusion {
  id: string;
  /** 所属钢琴 */
  pianoId: string;
  /** 生成时间（epoch ms） */
  createdAt: number;
  /** 最近复核 / 确认时间（epoch ms） */
  reviewedAt: number | null;
  /** 状态：待复核（最新但未确认）/ 已确认（生效中或历史）/ 已失效（环境改动后被顶掉） */
  status: ConclusionStatus;
  /** 生成结论时所依据的环境数据指纹 */
  envFingerprint: string;
  /** 参与计算的调律次数 */
  sampleCount: number;
  /** 综合漂移速度（音分 / 30 天，带正负号） */
  driftCentsPer30Days: number;
  /** 漂移快慢档位 */
  level: DriftSpeedLevel;
  /** 漂移最重音区 */
  worstZone: string;
  /** 总体走向 */
  trend: '走低' | '走高' | '平稳';
  /** 一句话总结 */
  summary: string;
  /** 建议条目 */
  advice: string[];
  /** 建议的下次调律周期（月），供提醒页沿用；null 表示不调整 */
  suggestedCycleMonths: number | null;
}

/** 从分析结果生成一条待复核结论所需的最小字段 */
export type DriftConclusionDraft = Omit<DriftConclusion, 'id' | 'createdAt' | 'reviewedAt' | 'status'>;

export const CONCLUSION_STATUSES: ConclusionStatus[] = ['待复核', '已确认', '已失效'];

/**
 * 依据当前环境指纹判断某条结论是否已失效。
 * 环境记录改动会改变指纹，旧结论随即失效，等待复核。
 */
export function isConclusionStale(conclusion: DriftConclusion, currentFingerprint: string): boolean {
  return conclusion.envFingerprint !== currentFingerprint;
}
