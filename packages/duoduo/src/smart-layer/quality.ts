import { SmartLayerClient } from "./client"
import type { QualityValidateRequest, QualityReport } from "./types"

/**
 * QualityClient provides typed access to the duo-smart-layer quality assurance API.
 *
 * The quality system validates code artifacts at different levels:
 *   - self_check: Basic automated validation
 *   - cross_review: Cross-review against project standards
 *   - full: Comprehensive quality analysis with suggestions
 */
export class QualityClient {
  constructor(private client: SmartLayerClient) {}

  /**
   * Validate a code artifact against the specified quality level.
   * Returns a quality report with pass/fail status, score, and suggestions.
   */
  async validate(request: QualityValidateRequest): Promise<QualityReport> {
    return this.client.post<QualityReport>("/quality/validate", request)
  }
}
