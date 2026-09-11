import { describe, test, expect } from "bun:test"
import { isOverflowErrorText } from "../../src/provider/error"

describe("isOverflowErrorText", () => {
  describe("matches all 31 OVERFLOW_PATTERNS", () => {
    test("Anthropic: 'prompt is too long'", () => {
      expect(isOverflowErrorText("prompt is too long")).toBe(true)
      expect(isOverflowErrorText("Prompt is too long for this model")).toBe(true)
      expect(isOverflowErrorText("The prompt is too long: 50000 tokens")).toBe(true)
    })

    test("Amazon Bedrock: 'input is too long for requested model'", () => {
      expect(isOverflowErrorText("input is too long for requested model")).toBe(true)
      expect(isOverflowErrorText("Input is too long for requested model")).toBe(true)
    })

    test("OpenAI: 'exceeds the context window'", () => {
      expect(isOverflowErrorText("exceeds the context window")).toBe(true)
      expect(isOverflowErrorText("This request exceeds the context window limit")).toBe(true)
    })

    test("Google Gemini: 'input token count...exceeds the maximum'", () => {
      expect(isOverflowErrorText("input token count of 50000 exceeds the maximum")).toBe(true)
      expect(isOverflowErrorText("Input token count 100000 exceeds the maximum allowed")).toBe(true)
    })

    test("xAI Grok: 'maximum prompt length is N'", () => {
      expect(isOverflowErrorText("maximum prompt length is 131072")).toBe(true)
      expect(isOverflowErrorText("Maximum prompt length is 8192")).toBe(true)
    })

    test("Groq: 'reduce the length of the messages'", () => {
      expect(isOverflowErrorText("reduce the length of the messages")).toBe(true)
      expect(isOverflowErrorText("Please reduce the length of the messages")).toBe(true)
    })

    test("OpenRouter/DeepSeek/vLLM: 'maximum context length is N tokens'", () => {
      expect(isOverflowErrorText("maximum context length is 128000 tokens")).toBe(true)
      expect(isOverflowErrorText("This model's maximum context length is 4096 tokens")).toBe(true)
    })

    test("GitHub Copilot: 'exceeds the limit of N'", () => {
      expect(isOverflowErrorText("exceeds the limit of 8192")).toBe(true)
      expect(isOverflowErrorText("Request exceeds the limit of 100000")).toBe(true)
    })

    test("llama.cpp: 'exceeds the available context size'", () => {
      expect(isOverflowErrorText("exceeds the available context size")).toBe(true)
      expect(isOverflowErrorText("Prompt exceeds the available context size")).toBe(true)
    })

    test("LM Studio: 'greater than the context length'", () => {
      expect(isOverflowErrorText("greater than the context length")).toBe(true)
      expect(isOverflowErrorText("Token count is greater than the context length")).toBe(true)
    })

    test("MiniMax: 'context window exceeds limit'", () => {
      expect(isOverflowErrorText("context window exceeds limit")).toBe(true)
      expect(isOverflowErrorText("The context window exceeds limit")).toBe(true)
    })

    test("Kimi/Moonshot: 'exceeded model token limit'", () => {
      expect(isOverflowErrorText("exceeded model token limit")).toBe(true)
      expect(isOverflowErrorText("You have exceeded model token limit")).toBe(true)
    })

    test("Generic fallback: 'context_length_exceeded' or 'context length exceeded'", () => {
      expect(isOverflowErrorText("context_length_exceeded")).toBe(true)
      expect(isOverflowErrorText("context length exceeded")).toBe(true)
      expect(isOverflowErrorText("Context_Length_Exceeded")).toBe(true)
    })

    test("HTTP 413: 'request entity too large'", () => {
      expect(isOverflowErrorText("request entity too large")).toBe(true)
      expect(isOverflowErrorText("Request Entity Too Large")).toBe(true)
    })

    test("vLLM: 'context length is only N tokens'", () => {
      expect(isOverflowErrorText("context length is only 4096 tokens")).toBe(true)
      expect(isOverflowErrorText("This model's context length is only 8192 tokens")).toBe(true)
    })

    test("vLLM: 'input length...exceeds...context length'", () => {
      expect(isOverflowErrorText("input length of 50000 exceeds the context length of 4096")).toBe(true)
      expect(isOverflowErrorText("Input length exceeds context length")).toBe(true)
    })

    test("Ollama: 'prompt too long; exceeded max context length'", () => {
      expect(isOverflowErrorText("prompt too long; exceeded max context length")).toBe(true)
      expect(isOverflowErrorText("prompt too long; exceeded context length")).toBe(true)
    })

    test("Mistral: 'too large for model with N maximum context length'", () => {
      expect(isOverflowErrorText("too large for model with 32768 maximum context length")).toBe(true)
      expect(isOverflowErrorText("Input too large for model with 128000 maximum context length")).toBe(true)
    })

    test("z.ai: 'model_context_window_exceeded'", () => {
      expect(isOverflowErrorText("model_context_window_exceeded")).toBe(true)
      expect(isOverflowErrorText("MODEL_CONTEXT_WINDOW_EXCEEDED")).toBe(true)
    })

    test("Xunfei Spark: 'range of input length should be'", () => {
      expect(isOverflowErrorText("range of input length should be [1, 202745]")).toBe(true)
      expect(isOverflowErrorText("Range of input length should be")).toBe(true)
    })

    test("Xunfei Spark combined: 'invalidparameter...range of input'", () => {
      expect(isOverflowErrorText("invalidparameter: range of input length should be")).toBe(true)
      expect(isOverflowErrorText("InvalidParameter: Range of input length")).toBe(true)
    })

    test("Xunfei Spark v2: 'input token limit'", () => {
      expect(isOverflowErrorText("input token limit is 202752")).toBe(true)
      expect(isOverflowErrorText("Input token limit")).toBe(true)
    })
  })

  describe("does not match normal error text", () => {
    test("network errors are not overflow", () => {
      expect(isOverflowErrorText("Connection timeout")).toBe(false)
      expect(isOverflowErrorText("ECONNREFUSED")).toBe(false)
      expect(isOverflowErrorText("Network error")).toBe(false)
    })

    test("auth errors are not overflow", () => {
      expect(isOverflowErrorText("Invalid API key")).toBe(false)
      expect(isOverflowErrorText("Unauthorized")).toBe(false)
      expect(isOverflowErrorText("Authentication failed")).toBe(false)
    })

    test("rate limit errors are not overflow", () => {
      expect(isOverflowErrorText("Rate limit exceeded")).toBe(false)
      expect(isOverflowErrorText("Too many requests")).toBe(false)
    })

    test("generic errors are not overflow", () => {
      expect(isOverflowErrorText("Internal server error")).toBe(false)
      expect(isOverflowErrorText("Bad request")).toBe(false)
      expect(isOverflowErrorText("Model not found")).toBe(false)
      expect(isOverflowErrorText("Service unavailable")).toBe(false)
    })

    test("partial matches that should not trigger", () => {
      // "context" alone is not enough
      expect(isOverflowErrorText("context")).toBe(false)
      // "exceeds" alone is not enough
      expect(isOverflowErrorText("exceeds")).toBe(false)
      // "prompt" alone is not enough
      expect(isOverflowErrorText("prompt")).toBe(false)
    })
  })

  describe("boundary conditions", () => {
    test("empty string returns false", () => {
      expect(isOverflowErrorText("")).toBe(false)
    })

    test("case-insensitive matching", () => {
      expect(isOverflowErrorText("PROMPT IS TOO LONG")).toBe(true)
      expect(isOverflowErrorText("EXCEEDS THE CONTEXT WINDOW")).toBe(true)
      expect(isOverflowErrorText("Request Entity Too Large")).toBe(true)
    })

    test("patterns work with surrounding text", () => {
      expect(isOverflowErrorText("Error: prompt is too long for the model")).toBe(true)
      expect(isOverflowErrorText("The request exceeds the context window of 128k tokens")).toBe(true)
      expect(isOverflowErrorText("400 Bad Request: input is too long for requested model")).toBe(true)
    })

    test("patterns work with embedded messages (Xunfei-style)", () => {
      expect(isOverflowErrorText("InvalidParameter: Range of input length should be [1, 202745]")).toBe(true)
      expect(isOverflowErrorText("EngineInternalError:InvalidParameter:range of input length should be [1, 202745]")).toBe(true)
    })
  })
})
