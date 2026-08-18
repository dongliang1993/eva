import { useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";

import { ChatPage } from "./features/threads/chat-page";
import { SettingsPage } from "./features/settings/settings-page";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000
    }
  }
});

function SettingsLayout() {
  const navigate = useNavigate();

  const handleBack = useCallback(() => {
    navigate("/chat");
  }, [navigate]);

  return (
    <div className="h-screen bg-background text-foreground">
      <SettingsPage onBack={handleBack} />
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/settings/*" element={<SettingsLayout />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
