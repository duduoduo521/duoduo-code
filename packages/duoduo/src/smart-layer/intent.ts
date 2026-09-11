import { SmartLayerClient } from "./client"
import type { IntentClarifyRequest, ClarificationResult } from "./types"

/**
 * IntentClient provides typed access to the duo-smart-layer intent clarification API.
 *
 * The intent system analyzes user input to:
 *   - Classify the intent type (question, command, discussion, etc.)
 *   - Extract named entities from the input
 *   - Detect ambiguities that may need user clarification
 *   - Suggest an appropriate interaction mode (Chat, Agent)
 */
export class IntentClient {
  constructor(private client: SmartLayerClient) {}

  /**
   * Clarify the user's intent from their input text.
   * Returns a classification result with confidence score, extracted entities,
   * detected ambiguities, and a suggested interaction mode.
   *
   * If project_context is provided, the clarifier can use it to improve
   * entity resolution and intent classification accuracy.
   */
  async clarify(request: IntentClarifyRequest): Promise<ClarificationResult> {
    return this.client.post<ClarificationResult>("/intent/clarify", request)
  }
}
