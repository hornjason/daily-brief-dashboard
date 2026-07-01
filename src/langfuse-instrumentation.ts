import { NodeSDK } from "@opentelemetry/sdk-node"
import { LangfuseSpanProcessor } from "@langfuse/otel"

export const langfuseSpanProcessor = new LangfuseSpanProcessor()

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
})

if (process.env.LANGFUSE_PUBLIC_KEY) {
  sdk.start()
}
