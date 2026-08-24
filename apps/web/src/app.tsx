import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { ThemeProvider } from "./shared/hooks/use-theme";
import { ChatPage } from "./features/threads/chat-page";
import { SettingsLayout } from "./features/settings/settings-layout";
import { ModelSettings } from "./features/settings/components/model-settings";
import { ProviderSettings } from "./features/settings/components/provider-settings";
import { MemorySettings } from "./features/settings/components/memory-settings";
import { McpSettings } from "./features/settings/components/mcp-settings";
import { SecuritySettings } from "./features/settings/components/security-settings";
import { AboutSettings } from "./features/settings/components/about-settings";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000
    }
  }
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="models" replace />} />
            <Route path="models" element={<ModelSettings />} />
            <Route path="providers" element={<ProviderSettings />} />
            <Route path="memory" element={<MemorySettings />} />
            <Route path="security" element={<SecuritySettings />} />
            <Route path="mcp" element={<McpSettings />} />
            <Route path="about" element={<AboutSettings />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}