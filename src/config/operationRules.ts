/**
 * Configurable route -> feature mapping. First match wins.
 * `estimatedUnits` may be a number, or a function of the request for variable-cost ops.
 * Keep this data-driven — handlers must not hard-code operation logic (spec §6.2).
 */
export interface OperationRule {
  method: string;
  pattern: RegExp;
  feature: string;
  estimatedUnits: number;
}

export const operationRules: OperationRule[] = [
  { method: 'POST', pattern: /^\/api\/ai\/generate/, feature: 'ai_generation', estimatedUnits: 3000 },
  { method: 'POST', pattern: /^\/api\/reports/, feature: 'advanced_reports', estimatedUnits: 500 },
];
