/// <reference types="vite/client" />

interface Window {
  wordbookDesktop?: {
    openExternal: (url: string) => Promise<void>;
    getSidecarStatus: () => Promise<{
      state: string;
      pid: number | null;
      managed: boolean;
      healthy: boolean;
      message: string;
      baseUrl: string;
      startedAt: string | null;
      lastExit: { code: number | null; signal: string | null; at: string } | null;
    }>;
    restartSidecar: () => Promise<unknown>;
    getSidecarLogs: () => Promise<Array<{
      id: string;
      at: string;
      level: string;
      source: string;
      message: string;
    }>>;
    clearSidecarLogs: () => Promise<unknown>;
    onSidecarStatus: (
      callback: (status: {
        state: string;
        pid: number | null;
        managed: boolean;
        healthy: boolean;
        message: string;
        baseUrl: string;
        startedAt: string | null;
        lastExit: { code: number | null; signal: string | null; at: string } | null;
      }) => void
    ) => () => void;
    onSidecarLog: (
      callback: (entry: {
        id: string;
        at: string;
        level: string;
        source: string;
        message: string;
      }) => void
    ) => () => void;
    platform: string;
  };
}
