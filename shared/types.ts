export type ProviderKind = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'compatible' | 'demo' | 'codex' | 'huggingface';
export interface ProviderConfig { kind: ProviderKind; model: string; baseUrl: string; apiKey?: string; hasKey?: boolean }
export type ThemePreference = 'system' | 'light' | 'dark';
export interface Settings { provider: ProviderConfig; workspace: string; maxSteps: number; allowCommands: boolean; allowComputer: boolean; pythonPath: string; theme?: ThemePreference; textSize?: 'normal' | 'large' | 'extra-large' }
export interface GPUInfo { name: string; vendor: string; memoryBytes: number | null; unified: boolean }
export interface HardwareInfo { platform: string; arch: string; cpu: string; logicalCores: number; totalMemoryBytes: number; availableMemoryBytes: number; gpus: GPUInfo[]; notes: string[] }
export interface ModelFit { rating: 'comfortable' | 'tight' | 'too-large' | 'unknown'; estimatedMemoryBytes: number | null; backend: string; explanation: string }
export interface HubModel { id: string; downloads: number; likes: number; gated: boolean; tags: string[]; recommendedFile?: HubFile }
export interface HubFile { path: string; sizeBytes: number; quantization: string; ollamaModel: string; fit: ModelFit }
export interface ModelDownload { model: string; status: string; completed: number; total: number; done: boolean; error?: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface Session { id: string; title: string; messages: Message[]; updatedAt: string }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface AgentMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string; name?: string; raw?: unknown; images?: string[] }
export interface ModelReply { text: string; toolCalls: ToolCall[]; raw?: unknown }
export type AgentEvent =
  | { type: 'status'; runId: string; message: string }
  | { type: 'message'; runId: string; message: Message }
  | { type: 'tool'; runId: string; call: ToolCall; status: 'running' | 'done' | 'denied' | 'error'; result?: string }
  | { type: 'approval'; runId: string; approvalId: string; call: ToolCall; reason: string }
  | { type: 'done'; runId: string; session: Session }
  | { type: 'error'; runId: string; message: string };
export interface Bootstrap { settings: Settings; sessions: Session[]; platform: string; secureStorage: boolean; version: string }
export interface OrbitAPI {
  hfStatus(): Promise<{ configured: boolean; connected: boolean; username?: string }>;
  hfLogin(): Promise<{ verificationUrl: string; userCode: string; expiresAt: number; intervalSeconds: number }>;
  hfPoll(): Promise<{ state: 'pending' | 'connected' | 'expired'; username?: string }>;
  hfCancel(): Promise<void>;
  hardware(): Promise<HardwareInfo>;
  searchModels(query: string): Promise<HubModel[]>;
  modelFiles(repo: string): Promise<HubFile[]>;
  downloadModel(input: { model: string; sizeBytes: number }): Promise<void>;
  downloadState(): Promise<ModelDownload | null>;
  cancelDownload(): Promise<void>;
  onDownload(callback: (event: ModelDownload) => void): () => void;
  codexLogin(): Promise<{ url: string; loginId: string }>;
  codexStatus(): Promise<{ authenticated: boolean; email?: string; plan?: string }>;
  bootstrap(): Promise<Bootstrap>;
  saveSettings(settings: Settings): Promise<Settings>;
  chooseWorkspace(): Promise<string | null>;
  testConnection(config: ProviderConfig): Promise<{ ok: boolean; message: string; models?: string[] }>;
  startRun(input: { sessionId?: string; prompt: string }): Promise<{ runId: string; sessionId: string }>;
  cancelRun(): Promise<void>;
  approve(input: { approvalId: string; approved: boolean }): Promise<void>;
  deleteSession(id: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onEvent(callback: (event: AgentEvent) => void): () => void;
}
declare global { interface Window { orbit?: OrbitAPI } }
