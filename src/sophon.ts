import { log } from "@utils";
interface GameOperationOptions {
  gamedir: string;
  game_type: string;
  tempdir?: string;
}
export interface SophonInstallOptions extends GameOperationOptions {
  install_reltype: string;
}
export interface SophonRepairOptions extends GameOperationOptions {
  repair_mode: string;
}
export interface SophonUpdateOptions extends GameOperationOptions {
  predownload: boolean;
}
export interface SophonProgressEvent {
  type: string;
  task_id: string;
  [key: string]: any;
}
export interface SophonOnlineGameInfo {
  game_type: "hk4e" | "nap" | "";
  version: string;
  install_size: number;
  download_size: number;
  temporary_size: number;
  updatable_versions: string[];
  release_type: "os" | "cn" | "bb";
  pre_download: boolean;
  pre_download_version?: string;
  error?: string;
}
export class SophonClient {
  private baseUrl: string;
  activeTaskId = "";
  constructor(host: string, port = 6969, private token = "") {
    this.baseUrl = `http://${host}:${port}`;
  }
  async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<any> {
    const response = await fetch(this.baseUrl + path, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        `${response.status}: ${result.detail || response.statusText}`
      );
    return result;
  }
  async healthCheck() {
    try {
      await this.request("/health");
      return true;
    } catch {
      return false;
    }
  }
  async startGameOperation(
    type: "install" | "repair" | "update",
    options: SophonInstallOptions | SophonRepairOptions | SophonUpdateOptions
  ) {
    const result = await this.request(`/api/${type}`, "POST", options);
    this.activeTaskId = result.task_id;
    return result.task_id as string;
  }
  startInstallation(options: SophonInstallOptions) {
    return this.startGameOperation("install", options);
  }
  startRepair(options: SophonRepairOptions) {
    return this.startGameOperation("repair", options);
  }
  startUpdate(options: SophonUpdateOptions) {
    return this.startGameOperation("update", options);
  }
  async *streamOperationProgress(
    taskId: string
  ): AsyncGenerator<SophonProgressEvent> {
    this.activeTaskId = taskId;
    const queue: SophonProgressEvent[] = [];
    const ws = new WebSocket(
      `${this.baseUrl.replace("http:", "ws:")}/ws/${taskId}`
    );
    ws.onopen = () => ws.send(JSON.stringify({ token: this.token }));
    ws.onmessage = event => {
      try {
        queue.push(JSON.parse(event.data));
      } catch {
        /* Polling remains authoritative. */
      }
    };
    // Poll terminal status too: early events, socket closure and fast failures must not become success.
    try {
      while (true) {
        while (queue.length) yield queue.shift()!;
        const state = await this.request(`/api/tasks/${taskId}/status`);
        if (state.status === "completed") return;
        if (state.status === "failed" || state.status === "cancelled")
          throw new Error(state.error || "任务失败或取消");
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      ws.close();
      this.activeTaskId = "";
    }
  }
  async cancelOperation(taskId: string) {
    await this.request(`/api/tasks/${taskId}`, "DELETE");
  }
  async cancelActiveOperation() {
    if (this.activeTaskId) await this.cancelOperation(this.activeTaskId);
  }
  getLatestOnlineGameInfo(
    reltype: "os" | "cn" | "bb",
    game: string
  ): Promise<SophonOnlineGameInfo> {
    return this.request(
      `/api/game/online_info?game=${encodeURIComponent(
        game
      )}&reltype=${reltype}`
    );
  }
}
export async function createSophon(host: string, port: number, token = "") {
  const client = new SophonClient(host, port, token);
  if (!(await client.healthCheck())) throw new Error("本地下载服务尚未就绪");
  return client;
}
export type Sophon = SophonClient;
export async function createSophonRetry(
  host: string,
  port: number,
  token = ""
) {
  for (let i = 0; i < 30; i++) {
    try {
      return await createSophon(host, port, token);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error("本地下载服务启动失败，请查看日志并重试");
}
