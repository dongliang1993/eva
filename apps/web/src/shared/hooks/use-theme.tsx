import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

// ---------------------------------------------------------------------------
// 主题模式: light / dark / system(跟随系统)
// .dark class 挂在 <html> 上, 由 use-theme 与 index.css 的 .dark 块驱动。
// 持久化在 localStorage("theme"), system 模式监听 prefers-color-scheme。
// ---------------------------------------------------------------------------

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

function getStoredMode(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function isSystemDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(SYSTEM_DARK_QUERY).matches;
}

function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "system" ? systemDark : mode === "dark";
}

/**
 * 在 React 挂载前同步应用主题, 消除首帧闪烁 (FOUC)。
 * 在 main.tsx 的 createRoot 之前调用一次。
 */
export function applyInitialTheme(): void {
  const dark = resolveDark(getStoredMode(), isSystemDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

interface ThemeContextValue {
  /** 用户选择的模式 (light / dark / system) */
  readonly mode: ThemeMode;
  /** 实际生效的是否暗色 (system 下已解析) */
  readonly isDark: boolean;
  readonly setMode: (mode: ThemeMode) => void;
  readonly toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(isSystemDark);

  // 跟随系统时, 监听操作系统的深浅偏好
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;

    const mql = matchMedia(SYSTEM_DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // 把解析出的明暗同步到 <html> class
  const resolvedDark = resolveDark(mode, systemDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedDark);
    document.documentElement.style.colorScheme = resolvedDark ? "dark" : "light";
  }, [resolvedDark]);

  const setMode = useCallback((next: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolvedDark ? "light" : "dark");
  }, [resolvedDark, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, isDark: resolvedDark, setMode, toggle }),
    [mode, resolvedDark, setMode, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return ctx;
}