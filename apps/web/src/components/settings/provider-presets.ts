export interface ProviderPreset {
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly defaultBaseURL: string;
  readonly baseURLHint: string;
  readonly apiKeyHint: string;
}

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    name: "Anthropic",
    description: "Claude models from Anthropic",
    icon: "A",
    defaultBaseURL: "https://api.anthropic.com",
    baseURLHint: "Leave empty to use the default Anthropic API endpoint",
    apiKeyHint: "Get your API key from Anthropic Console"
  },
  openai: {
    name: "OpenAI",
    description: "GPT models from OpenAI",
    icon: "G",
    defaultBaseURL: "https://api.openai.com/v1",
    baseURLHint: "Leave empty to use the default OpenAI API endpoint",
    apiKeyHint: "Get your API key from OpenAI Platform"
  },
  google: {
    name: "Google",
    description: "Gemini models from Google",
    icon: "G",
    defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    baseURLHint: "Leave empty to use the default Gemini API endpoint",
    apiKeyHint: "Get your API key from Google AI Studio"
  }
};

export const getProviderPreset = (
  providerId: string,
  providerName: string
): ProviderPreset => {
  const preset = PROVIDER_PRESETS[providerId];

  if (preset) {
    return preset;
  }

  return {
    name: providerName,
    description: `${providerName} provider`,
    icon: providerName.slice(0, 1).toUpperCase() || "?",
    defaultBaseURL: "",
    baseURLHint: "Use the provider's default base URL if required",
    apiKeyHint: "Enter the provider API key"
  };
};
