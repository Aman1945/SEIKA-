import type { ApiErrorBody, Audience, TokenPair } from "@seika/types";

/**
 * How the SDK stores tokens. Swappable so the dashboard can use
 * `sessionStorage`, the player PWA `localStorage`, and the kiosk an in-memory
 * store — none of which the SDK should know about.
 */
export interface TokenStore {
  get(): TokenPair | null;
  set(tokens: TokenPair | null): void;
}

export function memoryTokenStore(initial: TokenPair | null = null): TokenStore {
  let tokens = initial;
  return {
    get: () => tokens,
    set: (t) => {
      tokens = t;
    },
  };
}

/** Browser storage store. Falls back to memory where storage is unavailable. */
export function webTokenStore(key: string, storage?: Storage): TokenStore {
  const store = (() => {
    try {
      const s = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
      // Private modes expose the API and throw on use, so probe it.
      s?.setItem("__seika_probe", "1");
      s?.removeItem("__seika_probe");
      return s;
    } catch {
      return undefined;
    }
  })();

  if (!store) return memoryTokenStore();

  return {
    get() {
      try {
        const raw = store.getItem(key);
        return raw ? (JSON.parse(raw) as TokenPair) : null;
      } catch {
        return null;
      }
    },
    set(tokens) {
      try {
        if (tokens) store.setItem(key, JSON.stringify(tokens));
        else store.removeItem(key);
      } catch {
        /* storage full or blocked — the session still works in memory */
      }
    },
  };
}

/** A failed request, with the API's own error code preserved. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when re-authenticating could plausibly fix it. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface ClientOptions {
  baseUrl: string;
  tokens?: TokenStore;
  /** Called when refreshing fails, so the app can send the user to login. */
  onAuthExpired?: () => void;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the bearer header (login, webhooks, public leaderboards). */
  anonymous?: boolean;
  /** Return the raw Response — for file downloads. */
  raw?: boolean;
  signal?: AbortSignal;
}

/**
 * The SEIKA API client.
 *
 * Handles one thing the callers should never each reimplement: a 401 on an
 * expired access token triggers a single refresh, and every request that
 * arrived during that window waits for the same refresh instead of firing a
 * stampede of them — which would burn the rotating refresh token and log the
 * user out.
 */
export class SeikaClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenStore;
  private readonly doFetch: typeof fetch;
  private readonly onAuthExpired?: () => void;
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.tokens = opts.tokens ?? memoryTokenStore();
    // `fetch` must keep its original receiver: calling it as `this.doFetch(...)`
    // detaches it from `window`, which throws "Illegal invocation" in a browser.
    this.doFetch = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.onAuthExpired = opts.onAuthExpired;
  }

  get accessToken(): string | null {
    return this.tokens.get()?.accessToken ?? null;
  }

  get subjectType(): Audience | null {
    return this.tokens.get()?.subjectType ?? null;
  }

  get isAuthenticated(): boolean {
    return Boolean(this.tokens.get()?.accessToken);
  }

  setTokens(tokens: TokenPair | null): void {
    this.tokens.set(tokens);
  }

  logout(): void {
    this.tokens.set(null);
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async send(path: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (!opts.anonymous) {
      const token = this.tokens.get()?.accessToken;
      if (token) headers.authorization = `Bearer ${token}`;
    }

    return this.doFetch(this.url(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  }

  /** Rotates the refresh token. At most one rotation is ever in flight. */
  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const current = this.tokens.get();
      if (!current?.refreshToken) return false;
      try {
        const res = await this.doFetch(this.url("/api/auth/refresh"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as TokenPair & { ok: boolean };
        this.tokens.set({
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          subjectType: body.subjectType ?? current.subjectType,
        });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    let res = await this.send(path, opts);

    // One retry, and only for an expired access token on an authenticated call.
    if (res.status === 401 && !opts.anonymous && this.tokens.get()?.refreshToken) {
      const refreshed = await this.refresh();
      if (refreshed) {
        res = await this.send(path, opts);
      } else {
        this.tokens.set(null);
        this.onAuthExpired?.();
      }
    }

    if (opts.raw) {
      if (!res.ok) throw await this.toError(res);
      return res as unknown as T;
    }

    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async toError(res: Response): Promise<ApiError> {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || `Request failed with ${res.status}`;
    let details: unknown;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      /* a non-JSON body (a proxy error page) keeps the status-derived message */
    }
    if (res.status === 401 && !this.tokens.get()) this.onAuthExpired?.();
    return new ApiError(res.status, code, message, details);
  }

  /** Downloads a file, returning the blob and the server's filename. */
  async download(
    path: string,
    query?: RequestOptions["query"]
  ): Promise<{ blob: Blob; filename: string }> {
    const res = await this.request<Response>(path, { query, raw: true });
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/.exec(disposition);
    return {
      blob: await res.blob(),
      filename: match?.[1] ?? path.split("/").pop() ?? "download",
    };
  }
}
