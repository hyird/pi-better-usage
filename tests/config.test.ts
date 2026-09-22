import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  normalizeConfig,
  readConfig,
} from "../src/config.ts";
import { globalConfigPath, piAgentDir, projectConfigPath } from "../src/paths.ts";

const tempDirs: string[] = [];

function tempAgentDir(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-better-opencode-go-"));
  tempDirs.push(dir);
  return { PI_CODING_AGENT_DIR: dir };
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

afterEach(() => {
  tempDirs.length = 0;
});

describe("defaults", () => {
  it("ships a grok-style widget with every window", () => {
    expect(DEFAULT_CONFIG).toEqual({
      enabled: true,
      windows: ["rolling", "weekly", "monthly"],
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      onlyOnOpencodeModel: true,
      showAccountLabel: true,
      footerMode: "widget",
    });
  });
});

describe("normalizeConfig", () => {
  it("ignores anything that is not a config object", () => {
    for (const raw of [undefined, null, "nope", 42, []]) {
      expect(normalizeConfig(raw)).toEqual(DEFAULT_CONFIG);
    }
  });

  it("keeps endpoint order and drops unknown or duplicate windows", () => {
    expect(
      normalizeConfig({ windows: ["monthly", "weekly", "monthly", "hourly"] }).windows,
    ).toEqual(["weekly", "monthly"]);
    expect(normalizeConfig({ windows: ["weekly"] }).windows).toEqual(["weekly"]);
    expect(normalizeConfig({ windows: [] }).windows).toEqual([]);
  });

  it("ignores a non-array window list", () => {
    expect(normalizeConfig({ windows: "weekly" }).windows).toEqual(DEFAULT_CONFIG.windows);
  });

  it("clamps the refresh interval", () => {
    expect(normalizeConfig({ refreshIntervalMs: 1 }).refreshIntervalMs).toBe(
      MIN_REFRESH_INTERVAL_MS,
    );
    expect(normalizeConfig({ refreshIntervalMs: 1e12 }).refreshIntervalMs).toBe(
      MAX_REFRESH_INTERVAL_MS,
    );
    expect(normalizeConfig({ refreshIntervalMs: 30_000 }).refreshIntervalMs).toBe(30_000);
    expect(normalizeConfig({ refreshIntervalMs: Number.NaN }).refreshIntervalMs).toBe(
      DEFAULT_REFRESH_INTERVAL_MS,
    );
  });

  it("only accepts booleans for the toggles", () => {
    expect(normalizeConfig({ enabled: false, onlyOnOpencodeModel: false }).enabled).toBe(false);
    expect(normalizeConfig({ enabled: "no" }).enabled).toBe(true);
    expect(normalizeConfig({ showAccountLabel: false }).showAccountLabel).toBe(false);
    expect(normalizeConfig({ showAccountLabel: "no" }).showAccountLabel).toBe(true);
  });

  it("reads the flat footerMode key", () => {
    expect(normalizeConfig({ footerMode: "status" }).footerMode).toBe("status");
    expect(normalizeConfig({ footerMode: "off" }).footerMode).toBe("off");
    expect(normalizeConfig({ footerMode: "widget" }).footerMode).toBe("widget");
  });

  it("maps pi-better-grok's footer object onto our modes", () => {
    // Grok's "status" is the coloured below-editor widget, which we call "widget".
    expect(normalizeConfig({ footer: { mode: "status" } }).footerMode).toBe("widget");
    // Grok's "replace" takes over the whole footer, which we do not own.
    expect(normalizeConfig({ footer: { mode: "replace" } }).footerMode).toBe("status");
    expect(normalizeConfig({ footer: { mode: "off" } }).footerMode).toBe("off");
  });

  it("keeps the default for an unknown footer mode", () => {
    expect(normalizeConfig({ footerMode: "nope" }).footerMode).toBe("widget");
    expect(normalizeConfig({ footer: { mode: "nope" } }).footerMode).toBe("widget");
    expect(normalizeConfig({ footer: {} }).footerMode).toBe("widget");
  });

  it("ignores a footer value that is not the grok object", () => {
    expect(normalizeConfig({ footer: "status" }).footerMode).toBe("widget");
    expect(normalizeConfig({ footer: ["status"] }).footerMode).toBe("widget");
    expect(normalizeConfig({ footer: null }).footerMode).toBe("widget");
  });

  it("applies every field at once", () => {
    expect(
      normalizeConfig({
        enabled: false,
        windows: ["monthly"],
        refreshIntervalMs: 120_000,
        onlyOnOpencodeModel: false,
        showAccountLabel: false,
        footerMode: "status",
      }),
    ).toEqual({
      enabled: false,
      windows: ["monthly"],
      refreshIntervalMs: 120_000,
      onlyOnOpencodeModel: false,
      showAccountLabel: false,
      footerMode: "status",
    });
  });
});

describe("readConfig", () => {
  it("falls back to the defaults when nothing is configured", () => {
    expect(readConfig(tempAgentDir())).toEqual(DEFAULT_CONFIG);
  });

  it("reads the global config file", () => {
    const env = tempAgentDir();
    writeConfig(globalConfigPath(env), { footerMode: "off" });
    expect(readConfig(env).footerMode).toBe("off");
  });

  it("survives a corrupt config file", () => {
    const env = tempAgentDir();
    const path = globalConfigPath(env);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(readConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it("layers the project config over the global one", () => {
    const env = tempAgentDir();
    const cwd = mkdtempSync(join(tmpdir(), "pi-better-opencode-go-proj-"));
    tempDirs.push(cwd);
    writeConfig(globalConfigPath(env), { footerMode: "off", refreshIntervalMs: 120_000 });
    writeConfig(projectConfigPath(cwd), { footerMode: "status" });

    const config = readConfig(env, cwd);
    expect(config.footerMode).toBe("status");
    expect(config.refreshIntervalMs).toBe(120_000);
  });
});

describe("paths", () => {
  it("honours PI_CODING_AGENT_DIR, including a leading tilde", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }, "/home/x")).toBe("/custom/agent");
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }, "/home/x")).toBe("/home/x/custom");
    expect(piAgentDir({}, "/home/x")).toBe(join("/home/x", ".pi", "agent"));
  });

  it("places the config next to the other extension configs", () => {
    expect(globalConfigPath({ PI_CODING_AGENT_DIR: "/agent" })).toBe(
      join("/agent", "extensions", "opencode-go-usage.json"),
    );
    expect(projectConfigPath("/repo")).toBe(
      join("/repo", ".pi", "extensions", "opencode-go-usage.json"),
    );
  });
});
