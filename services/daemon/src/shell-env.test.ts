/**
 * FRI-150: shell-env capture behavior tests.
 *
 * Strategy: dependency-inject `spawnImpl` + `existsImpl` so we don't have to
 * mock `node:child_process` globally. The injected spawn returns a minimal
 * `EventEmitter`-shaped child whose stdout/stderr are also `EventEmitter`s,
 * so we can synthesize the same on('data')/on('exit') sequence the real
 * `cross-spawn` / Node spawn produces.
 *
 * Every assertion pins a specific value (env contents, fallback reason,
 * logged event name + fields). No `.not.toThrow()` as sole assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("./log.js", () => ({
  logger: { log: logMock, close: vi.fn() },
}));

const {
  captureShellEnv,
  getResolvedShellEnv,
  loadResolvedShellEnvFromJson,
  serializeShellEnv,
  __resetForTests,
  SHELL_ENV_ENV_VAR,
} = await import("./shell-env.js");

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const START = "__FRIDAY_SHELL_ENV_START__";
const END = "__FRIDAY_SHELL_ENV_END__";

function markerPayload(env: Record<string, string>, opts: { noisyPrefix?: string } = {}): string {
  const prefix = opts.noisyPrefix ?? "";
  return `${prefix}\n${START}\n${JSON.stringify(env)}\n${END}\n`;
}

beforeEach(() => {
  __resetForTests();
  logMock.mockClear();
});

afterEach(() => {
  __resetForTests();
});

describe("captureShellEnv — success path", () => {
  it("returns parsed env, source 'shell', logs daemon.shell-env.captured with shell + durationMs + path length", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });

    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        markerPayload({
          PATH: "/Users/me/.local/share/fnm/node-versions/v22.21.1/installation/bin:/usr/bin",
          FNM_DIR: "/Users/me/.local/share/fnm",
          HOME: "/Users/me",
        }),
      );
      child.emit("exit", 0, null);
    });

    const result = await promise;

    expect(result.source).toBe("shell");
    expect(result.shell).toBe("/bin/zsh");
    expect(result.env.PATH).toBe(
      "/Users/me/.local/share/fnm/node-versions/v22.21.1/installation/bin:/usr/bin",
    );
    expect(result.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.fallbackReason).toBeUndefined();

    // Spawn invoked with `-ilc` for zsh.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [shellArg, argvArg] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shellArg).toBe("/bin/zsh");
    expect(argvArg[0]).toBe("-ilc");
    expect(argvArg[1]).toContain(START);
    expect(argvArg[1]).toContain(END);

    // Captured event logged with the right fields.
    const captured = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.captured");
    expect(captured).toBeDefined();
    expect(captured?.[0]).toBe("info");
    expect(captured?.[2]).toMatchObject({
      shell: "/bin/zsh",
      pathLength: result.env.PATH.length,
      path: result.env.PATH,
    });
    expect(typeof captured?.[2].durationMs).toBe("number");
  });

  it("uses -ilc flags for bash too", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/bash",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv[0]).toBe("-ilc");
  });

  it("uses -ic flags for tcsh", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/usr/local/bin/tcsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv[0]).toBe("-ic");
  });

  it("uses -Login -Command flags for pwsh", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/usr/local/bin/pwsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv.slice(0, 2)).toEqual(["-Login", "-Command"]);
  });

  it("parses marker-delimited JSON even when rc-file output prepends noise", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        markerPayload(
          { PATH: "/clean/path", FNM_DIR: "/Users/me/.local/share/fnm" },
          {
            noisyPrefix:
              'oh-my-zsh: Loading...\nwarning: foo\n[user@host] $\nbroken=printf "noise"\n',
          },
        ),
      );
      child.emit("exit", 0, null);
    });

    const result = await promise;
    expect(result.source).toBe("shell");
    expect(result.env.PATH).toBe("/clean/path");
    expect(result.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("seeds the singleton so subsequent getResolvedShellEnv() calls return it", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/cached" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const after = getResolvedShellEnv();
    expect(after.source).toBe("shell");
    expect(after.env.PATH).toBe("/cached");
  });
});

describe("captureShellEnv — fallback paths", () => {
  it("falls back to process.env with reason 'no-shell-detected' when $SHELL is missing AND /bin/zsh + /bin/bash don't exist", async () => {
    const prevShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const result = await captureShellEnv({
        existsImpl: () => false,
        spawnImpl: vi.fn() as unknown as typeof import("node:child_process").spawn,
      });
      expect(result.source).toBe("process");
      expect(result.fallbackReason).toBe("no-shell-detected");
      expect(result.shell).toBeUndefined();

      const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
      expect(evt).toBeDefined();
      expect(evt?.[0]).toBe("warn");
      expect(evt?.[2].reason).toBe("no-shell-detected");
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
    }
  });

  it("prefers /bin/zsh over $SHELL=/bin/sh on weird launchd boots", async () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const child = makeChild();
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
      const existsImpl = vi.fn((p: import("node:fs").PathLike) => p === "/bin/zsh");

      const promise = captureShellEnv({
        spawnImpl,
        existsImpl: existsImpl as unknown as typeof import("node:fs").existsSync,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
        child.emit("exit", 0, null);
      });
      const result = await promise;
      expect(result.shell).toBe("/bin/zsh");
      const [shellArg] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(shellArg).toBe("/bin/zsh");
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });

  it("falls back when shell exits non-zero, with reason mentioning exit code + stderr tail", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stderr.emit("data", "zsh:7: command not found: nvm_use\n");
      child.emit("exit", 2, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/code=2/);
    expect(result.fallbackReason).toMatch(/nvm_use/);
    expect(result.shell).toBe("/bin/zsh");

    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
    expect(evt?.[2].shell).toBe("/bin/zsh");
    expect(evt?.[2].reason).toMatch(/code=2/);
  });

  it("times out and falls back with reason 'timed out after Nms'", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      timeoutMs: 100,
      spawnImpl,
      existsImpl: () => true,
    });
    vi.advanceTimersByTime(150);
    const result = await promise;
    vi.useRealTimers();

    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/timed out after 100ms/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
    expect(evt?.[2].reason).toMatch(/timed out/);
  });

  it("falls back with reason 'markers not found' when the shell exits 0 but stdout lacks markers", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", "completely unrelated output\nno markers here\n");
      child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toBe("markers not found in shell output");
  });

  it("falls back with a JSON.parse error reason when the markers wrap invalid JSON", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", `\n${START}\nthis-is-not-json\n${END}\n`);
      child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/JSON\.parse failed/);
  });

  it("falls back when the spawned shell raises an error event", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.emit("error", new Error("ENOENT zsh"));
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toBe("ENOENT zsh");
  });
});

describe("getResolvedShellEnv — pre-capture fallback", () => {
  it("returns a process.env snapshot with fallbackReason 'not-captured' before captureShellEnv runs", () => {
    process.env.__FRIDAY_TEST_KEY = "sentinel";
    try {
      const result = getResolvedShellEnv();
      expect(result.source).toBe("process");
      expect(result.fallbackReason).toBe("not-captured");
      expect(result.env.__FRIDAY_TEST_KEY).toBe("sentinel");
    } finally {
      delete process.env.__FRIDAY_TEST_KEY;
    }
  });
});

describe("serializeShellEnv / loadResolvedShellEnvFromJson — worker propagation", () => {
  it("round-trips the captured singleton", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/round/trip", FNM_DIR: "/x" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const json = serializeShellEnv();
    expect(json.length).toBeGreaterThan(0);

    __resetForTests();
    // Confirm singleton is gone — getResolvedShellEnv reports the pre-capture
    // sentinel reason now.
    expect(getResolvedShellEnv().fallbackReason).toBe("not-captured");

    loadResolvedShellEnvFromJson(json);
    const reseeded = getResolvedShellEnv();
    expect(reseeded.source).toBe("shell");
    expect(reseeded.env.PATH).toBe("/round/trip");
    expect(reseeded.env.FNM_DIR).toBe("/x");
  });

  it("serializeShellEnv returns empty string when no capture has run", () => {
    expect(serializeShellEnv()).toBe("");
  });

  it("loadResolvedShellEnvFromJson tolerates empty/undefined payloads as a no-op (no singleton seeded)", () => {
    loadResolvedShellEnvFromJson("");
    loadResolvedShellEnvFromJson(undefined);
    expect(getResolvedShellEnv().fallbackReason).toBe("not-captured");
  });

  it("loadResolvedShellEnvFromJson logs and bails on malformed JSON", () => {
    loadResolvedShellEnvFromJson("{not-json");
    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.deserialize.invalid");
    expect(evt).toBeDefined();
    expect(evt?.[0]).toBe("warn");
    expect(getResolvedShellEnv().fallbackReason).toBe("not-captured");
  });

  it("loadResolvedShellEnvFromJson logs and bails on shape-mismatch JSON", () => {
    loadResolvedShellEnvFromJson(JSON.stringify({ env: null }));
    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.deserialize.invalid");
    expect(evt?.[2].reason).toBe("shape-mismatch");
    expect(getResolvedShellEnv().fallbackReason).toBe("not-captured");
  });
});

describe("SHELL_ENV_ENV_VAR — public env-var name contract", () => {
  it("is the agreed-upon name lifecycle.ts uses for worker forwarding", () => {
    expect(SHELL_ENV_ENV_VAR).toBe("FRIDAY_RESOLVED_SHELL_ENV_JSON");
  });
});
