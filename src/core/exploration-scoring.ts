import { z } from 'zod';

const axis = z.number().int().min(0).max(10);
/** Discovery value and source support describe different things. Null means
 * unavailable to assess, never a zero-quality judgement about unseen content. */
export const discoveryAssessmentSchema = z.object({
  basis: z.enum(['content', 'preview']),
  substance: axis.nullable(), novelty: axis, relevance: axis, utility: axis.nullable(),
  support: z.enum(['firsthand', 'attributed', 'insufficient']),
}).strict().superRefine((value, ctx) => {
  if (value.basis === 'preview' && value.substance !== null)
    ctx.addIssue({ code: 'custom', message: '未读正文或未看视频的实质份量必须留空' });
  if (value.basis === 'content' && value.substance === null)
    ctx.addIssue({ code: 'custom', message: '评价已取得内容时必须说明实质份量' });
});
export type DiscoveryAssessment = z.infer<typeof discoveryAssessmentSchema>;

export function discoveryScore(kind: 'news' | 'learning' | 'opinion' | 'tool', assessment: DiscoveryAssessment): number {
  // News favours new developments and personal interest; learning favours use.
  // Evidence support is reported separately, rather than deducted a second time.
  const weights = kind === 'news' ? [1, 4, 5, 0] : kind === 'opinion' ? [2, 3, 3, 2] : [2, 1, 3, 4];
  const values = [assessment.substance, assessment.novelty, assessment.relevance, assessment.utility];
  let total = 0, weight = 0;
  values.forEach((value, index) => { if (value !== null) { total += value * weights[index]!; weight += weights[index]!; } });
  return Math.round(total * 10 / weight);
}

export function discoveryEligible(assessment: DiscoveryAssessment): boolean {
  return assessment.support !== 'insufficient' && assessment.relevance >= 6
    && (assessment.substance === null || assessment.substance >= 4)
    && (assessment.novelty >= 4 || (assessment.utility ?? 0) >= 6);
}

export function discoveryCoverageLabel(assessment: DiscoveryAssessment): string {
  const support = { firsthand: '原作者陈述', attributed: '转述线索', insufficient: '线索不足' }[assessment.support];
  return `${support} · ${assessment.basis === 'preview' ? '正文或视频内容尚未评价' : '基于已取得文字评价'}；事实与效果仍需核对`;
}
