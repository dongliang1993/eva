export interface HandleImWebhookInput {
  headers: Record<string, string | undefined>;
  payload: unknown;
  rawBody: string;
}

