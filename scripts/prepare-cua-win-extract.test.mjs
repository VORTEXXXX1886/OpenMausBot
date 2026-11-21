import { describe, expect, it } from "vitest";
import { inspectExtractedBinary } from "./prepare-cua-win.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const expectedVersion = "0.45.4";
const expectedSha = (content) =>
  createHash("sha256").update(content).digest("hex");

function makeCache(files) {
  const dir = mkdtempSync(join(tmpdir(), "omb-cua-extract-test-"));
  for (const [name, content] of Object.entries(files ?? {})) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function probeThat(versionOrError) {
  if (versionOrError instanceof Error) {
    return async () => { throw versionOrError; };
  }
  return async () => versionOrError;
}

describe("inspectExtractedBinary (post-extraction CUA diagnostics)", () => {
  it("reports missing when the executable is absent", async () => {
    const dir = makeCache({});
    try {
      const result = await inspectExtractedBinary(dir);
      expect(result.present).toBe(false);
      expect(result.regularFile).toBe(false);
      expect(result.size).toBeNull();
      expect(result.sha256).toBeNull();
      expect(result.version).toBeNull();
      expect(result.versionError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a regular file with size and sha256", async () => {
    const content = Buffer.alloc(1024, 0x7a);
    const dir = makeCache({ "cua-driver.exe": content });
    try {
      const result = await inspectExtractedBinary(dir, {
        versionProbe: probeThat(expectedVersion),
      });
      expect(result.present).toBe(true);
      expect(result.regularFile).toBe(true);
      expect(result.size).toBe(1024);
      expect(result.sha256).toBe(expectedSha(content));
      expect(result.version).toBe(expectedVersion);
      expect(result.versionError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an executable that disappears between two inspections", async () => {
    const dir = makeCache({ "cua-driver.exe": Buffer.from("MZ") });
    try {
      const first = await inspectExtractedBinary(dir);
      expect(first.present).toBe(true);
      expect(first.regularFile).toBe(true);

      // Simulate a filesystem actor removing the extracted executable after the
      // first inspection but before version validation.
      rmSync(join(dir, "cua-driver.exe"), { force: true });

      const second = await inspectExtractedBinary(dir);
      expect(second.present).toBe(false);
      expect(second.regularFile).toBe(false);
      expect(second.size).toBeNull();
      expect(second.sha256).toBeNull();
      expect(second.version).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a directory named cua-driver.exe as not a regular file", async () => {
    const dir = makeCache({});
    mkdirSync(join(dir, "cua-driver.exe"), { recursive: true });
    try {
      const result = await inspectExtractedBinary(dir);
      expect(result.present).toBe(true);
      expect(result.regularFile).toBe(false);
      expect(result.size).toBe(0);
      expect(result.sha256).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink named cua-driver.exe", async () => {
    const dir = makeCache({});
    try {
      symlinkSync(join(dir, "some-other-file.exe"), join(dir, "cua-driver.exe"));
    } catch {
      // Symlinks may not be creatable in this environment (e.g. without
      // developer mode or elevated privileges on Windows). Skip if unavailable.
      return;
    }
    try {
      const result = await inspectExtractedBinary(dir);
      expect(result.present).toBe(true);
      expect(result.regularFile).toBe(false);
      expect(result.sha256).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a version probe failure as versionError with no version", async () => {
    const dir = makeCache({ "cua-driver.exe": Buffer.from("MZ") });
    try {
      const result = await inspectExtractedBinary(dir, {
        versionProbe: probeThat(new Error("the system cannot find the file specified")),
      });
      expect(result.present).toBe(true);
      expect(result.regularFile).toBe(true);
      expect(result.version).toBeNull();
      expect(result.versionError).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an incorrect executable version", async () => {
    const dir = makeCache({ "cua-driver.exe": Buffer.from("MZ") });
    try {
      const result = await inspectExtractedBinary(dir, {
        versionProbe: probeThat("0.1.0"),
      });
      expect(result.version).toBe("0.1.0");
      expect(result.version).not.toBe(expectedVersion);
      expect(result.versionError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the pinned version on success", async () => {
    const dir = makeCache({ "cua-driver.exe": Buffer.from("MZ") });
    try {
      const result = await inspectExtractedBinary(dir, {
        versionProbe: probeThat(expectedVersion),
      });
      expect(result.version).toBe(expectedVersion);
      expect(result.versionError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
