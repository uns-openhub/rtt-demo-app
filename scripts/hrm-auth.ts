/**
 * Shared auth helpers used by HRM CLI scripts.
 */
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { ServiceTokenProvider, type AccessTokenProvider } from "@uns-kit/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HrmCliConfig {
  baseUrl: string;
  processName: string;
  defaultEmail: string;
  configToken?: string;
}

const EARLY_REFRESH_MS = 60_000;

type AuthPayload = {
  accessToken?: string;
};

export function loadConfig(): HrmCliConfig {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "../config.json"), "utf8")) as {
    uns?: Record<string, unknown>;
  };
  const uns = raw.uns ?? {};
  return {
    baseUrl: uns.rest as string,
    processName: uns.processName as string,
    defaultEmail: typeof uns.email === "string" ? uns.email : "",
    configToken: typeof uns.token === "string" ? uns.token : undefined,
  };
}

export function hasConfiguredServiceToken(config: HrmCliConfig): boolean {
  return Boolean(process.env.UNS_SERVICE_TOKEN_FILE || process.env.UNS_SERVICE_TOKEN || config.configToken);
}

export async function promptLine(question: string, defaultVal = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const display = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

export async function promptPassword(question = "Password"): Promise<string> {
  process.stdout.write(`${question}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve) => {
    let value = "";
    const handler = (char: string) => {
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");
        resolve(value);
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(0);
      } else if (char === "\u007F") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        value += char;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", handler);
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function decodeJwtExpiryMs(token: string): number | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseCookieHeader(cookieHeader?: string): Map<string, string> {
  const jar = new Map<string, string>();
  if (!cookieHeader) return jar;
  for (const part of cookieHeader.split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    jar.set(part.slice(0, index), part.slice(index + 1));
  }
  return jar;
}

function getSetCookieHeaders(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookies(existing: string | null, setCookieHeaders: string[]): string | null {
  const jar = parseCookieHeader(existing ?? undefined);
  for (const header of setCookieHeaders) {
    const first = header.split(";")[0]?.trim();
    if (!first) continue;
    const index = first.indexOf("=");
    if (index <= 0) continue;
    const name = first.slice(0, index);
    const value = first.slice(index + 1);
    if (value) {
      jar.set(name, value);
    } else {
      jar.delete(name);
    }
  }
  if (jar.size === 0) return null;
  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
}

async function readJson<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

async function describeHttpError(prefix: string, res: Response): Promise<Error> {
  try {
    const body = await readJson<Record<string, unknown>>(res);
    const detail = typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : JSON.stringify(body);
    return new Error(`${prefix}: ${res.status} ${res.statusText}${detail ? ` (${detail})` : ""}`);
  } catch {
    return new Error(`${prefix}: ${res.status} ${res.statusText}`);
  }
}

async function expectAccessToken(res: Response, prefix: string): Promise<string> {
  if (!res.ok) {
    throw await describeHttpError(prefix, res);
  }
  const body = await readJson<AuthPayload>(res);
  if (!body.accessToken) {
    throw new Error(`${prefix}: response did not contain an accessToken`);
  }
  return body.accessToken;
}

export class HrmAuthSession {
  private readonly baseUrl: string;
  private readonly email?: string;
  private readonly password?: string;
  private readonly tokenProvider?: AccessTokenProvider;
  private accessToken?: string;
  private expiresAtMs: number | null;
  private cookieHeader: string | null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<string> | null = null;

  private constructor(
    baseUrl: string,
    options: {
      email?: string;
      password?: string;
      accessToken?: string;
      cookieHeader?: string | null;
      tokenProvider?: AccessTokenProvider;
    },
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.email = options.email;
    this.password = options.password;
    this.tokenProvider = options.tokenProvider;
    this.accessToken = options.accessToken;
    this.expiresAtMs = options.accessToken ? decodeJwtExpiryMs(options.accessToken) : null;
    this.cookieHeader = options.cookieHeader ?? null;
    if (!this.tokenProvider) {
      this.scheduleAutoRefresh();
    }
  }

  static async login(baseUrl: string, email: string, password: string): Promise<HrmAuthSession> {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const res = await fetch(`${normalizedBaseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const accessToken = await expectAccessToken(res, "Login failed");
    const cookieHeader = mergeCookies(null, getSetCookieHeaders(res));
    return new HrmAuthSession(normalizedBaseUrl, { email, password, accessToken, cookieHeader });
  }

  static fromTokenProvider(baseUrl: string, tokenProvider: AccessTokenProvider): HrmAuthSession {
    return new HrmAuthSession(baseUrl, { tokenProvider });
  }

  close(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async apiGet(path: string): Promise<unknown> {
    return await this.request("GET", path);
  }

  async apiPost(path: string, body: unknown): Promise<unknown> {
    return await this.request("POST", path, body);
  }

  private scheduleAutoRefresh(): void {
    this.close();
    if (this.expiresAtMs === null) return;
    const delayMs = Math.max(1_000, this.expiresAtMs - Date.now() - EARLY_REFRESH_MS);
    this.refreshTimer = setTimeout(() => {
      void this.ensureFreshToken(true).catch(() => undefined);
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  private setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
    this.expiresAtMs = decodeJwtExpiryMs(accessToken);
    this.scheduleAutoRefresh();
  }

  private shouldRefreshSoon(): boolean {
    return this.expiresAtMs !== null && Date.now() >= this.expiresAtMs - EARLY_REFRESH_MS;
  }

  private async ensureFreshToken(force = false): Promise<string> {
    if (this.tokenProvider) {
      const token = await this.tokenProvider.getAccessToken();
      if (!token) {
        throw new Error("No service token available. Set UNS_SERVICE_TOKEN_FILE, UNS_SERVICE_TOKEN, or uns.token.");
      }
      this.accessToken = token;
      this.expiresAtMs = decodeJwtExpiryMs(token);
      return token;
    }

    if (!this.accessToken) {
      return await this.refreshAccessToken();
    }
    if (!force && !this.shouldRefreshSoon()) {
      return this.accessToken;
    }
    if (this.refreshInFlight) {
      return await this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      try {
        return await this.refreshAccessToken();
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return await this.refreshInFlight;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.cookieHeader) {
      try {
        const res = await fetch(`${this.baseUrl}/auth/refresh`, {
          method: "POST",
          headers: { Cookie: this.cookieHeader },
        });
        const accessToken = await expectAccessToken(res, "Token refresh failed");
        this.cookieHeader = mergeCookies(this.cookieHeader, getSetCookieHeaders(res));
        this.setAccessToken(accessToken);
        return accessToken;
      } catch {
        // Fall back to a fresh login when the refresh session is gone or rotated out.
      }
    }

    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const accessToken = await expectAccessToken(res, "Re-login failed");
    this.cookieHeader = mergeCookies(this.cookieHeader, getSetCookieHeaders(res));
    this.setAccessToken(accessToken);
    return accessToken;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const normalizedPath = path.replace(/^\/+/, "");
    let accessToken = await this.ensureFreshToken();
    let response = await this.fetchAuthorized(method, normalizedPath, accessToken, body);
    if (response.status === 401) {
      accessToken = await this.ensureFreshToken(true);
      response = await this.fetchAuthorized(method, normalizedPath, accessToken, body);
    }
    if (!response.ok) {
      throw await describeHttpError(`${method} ${normalizedPath} failed`, response);
    }
    return await readJson<unknown>(response);
  }

  private async fetchAuthorized(
    method: "GET" | "POST",
    path: string,
    accessToken: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    return await fetch(`${this.baseUrl}/${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  }
}

export async function createAuthSession(baseUrl: string, email: string, password: string): Promise<HrmAuthSession> {
  return await HrmAuthSession.login(baseUrl, email, password);
}

export function createServiceTokenSession(config: HrmCliConfig): HrmAuthSession {
  return HrmAuthSession.fromTokenProvider(
    config.baseUrl,
    new ServiceTokenProvider({ configToken: config.configToken }),
  );
}
