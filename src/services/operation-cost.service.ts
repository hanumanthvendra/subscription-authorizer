import { operationRules, type OperationRule } from '../config/operationRules';
import type { OperationMatch } from '../types';

/**
 * Resolves (method, uri) to a paid operation. Returns null for free/unmatched routes,
 * which the authorizer allows without reserving points.
 */
export class OperationCostService {
  constructor(private readonly rules: OperationRule[] = operationRules) {}

  resolve(method: string, uri: string): OperationMatch | null {
    const path = uri.split('?')[0] ?? uri;
    const upper = method.toUpperCase();
    for (const rule of this.rules) {
      if (rule.method.toUpperCase() === upper && rule.pattern.test(path)) {
        return {
          feature: rule.feature,
          estimatedUnits: rule.estimatedUnits,
          operation: `${upper} ${path}`,
        };
      }
    }
    return null;
  }
}

export const operationCostService = new OperationCostService();
