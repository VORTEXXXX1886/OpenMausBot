// Stage the Windows CUA executable and native SDK outside ASAR.
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createBackgroundExecutable } from "./cua-windows-background.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const stage = join(root, "dist-native", "cua-win32-x64");
const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
const sdkRoot = realpathSync(join(dirname(sdkEntry), ".."));
const dependencyRoot = join(sdkRoot, "..", "..");
const sdkPackage = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
const expectedVersion = String(sdkPackage.version);

const release = {
  version: "0.45.4",
  file: "cua-driver-rs-0.45.4-windows-x86_64-binary.zip",
  sha256: "949927b4cb0519c6fb1377878d67d79a8d6fae7bc56cbed17c7aa26448d82cb5",
};

if (expectedVersion !== release.version) {
  throw new Error(
    `CUA SDK ${expectedVersion} has no pinned executable asset in prepare-cua-win.mjs; update the release checksum first`,
  );
}

async function binaryVersion(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const { stdout } = await run(candidate, ["--version"], { timeout: 5000, windowsHide: true });
    return stdout.match(/cua-driver\s+([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Default version probe: runs the candidate executable with `--version` and
 * returns the parsed `cua-driver <version>` string, or null when the output
 * does not match. Throws when the executable cannot be executed.
 */
async function defaultVersionProbe(candidate) {
  const { stdout } = await run(candidate, ["--version"], { timeout: 5000, windowsHide: true });
  return stdout.match(/cua-driver\s+([\d.]+)/)?.[1] ?? null;
}

/** Side-effect-free inspection of an already-extracted CUA executable.
 *
 * Used both by the packaging script (after Expand-Archive) and by regression
 * tests. It never downloads, never extracts, never deletes, and never changes
 * Defender or any other security setting.
 *
 * The `versionProbe` parameter is injected so tests can exercise every
 * classification path without executing a real CUA driver or mocking
 * `node:child_process`.
 */
export async function inspectExtractedBinary(cacheDir, { versionProbe = defaultVersionProbe } = {}) {
  const candidate = join(cacheDir, "cua-driver.exe");
  const result = {
    candidate,
    present: existsSync(candidate),
    regularFile: false,
    size: null,
    sha256: null,
    version: null,
    versionError: null,
  };
  if (!result.present) return result;
  try {
    const linkDetails = await lstat(candidate);
    if (linkDetails.isSymbolicLink()) {
      // Reject symlinks: we only accept a regular file we extracted ourselves.
      return result;
    }
    const details = await stat(candidate);
    result.regularFile = details.isFile();
    result.size = details.size;
  } catch {
    return result;
  }
  if (!result.regularFile) return result;
  try {
    result.sha256 = createHash("sha256").update(await readFile(candidate)).digest("hex");
  } catch {
    return result;
  }
  try {
    result.version = await versionProbe(candidate);
  } catch (error) {
    result.versionError = String(error?.message ?? error);
  }
  return result;
}

/** Narrow, read-only Defender signal used only when the extracted executable
 * has disappeared. It reports only whether Windows Security has any active
 * threat or detection whose resource mentions cua-driver or the cache path,
 * plus whether real-time protection is enabled. It never lists full exclusions,
 * private paths, unrelated threat records, or sensitive settings, and it never
 * changes Defender state. A missing executable is never attributed to Defender
 * unless this returns corroborating evidence.
 */
async function defenderSignalFor(cacheDir) {
  if (process.platform !== "win32") return { available: false };
  const ps = (script) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 60_000,
      windowsHide: true,
    }).then((r) => r.out.trim());
  const escape = (s) => String(s).replace(/'/g, "''");
  const cache = escape(cacheDir);
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$realtime = (Get-MpComputerStatus -ErrorAction SilentlyContinue).RealTimeProtectionEnabled
$hits = @()
foreach ($threat in @(Get-MpThreat -ErrorAction SilentlyContinue) + @(Get-MpThreatDetection -ErrorAction SilentlyContinue)) {
  $resources = @($threat.Resources | ForEach-Object { "$_" })
  if ($resources -match 'cua-driver' -or $resources -match '${cache}') {
    $hits += [pscustomobject]@{
      name = "$($threat.ThreatName ?? $threat.ThreatID)"
      action = "$($threat.CleaningActionID ?? $threat.Action)"
      succeeded = [bool]($threat.ActionSuccess ?? $threat.Succeeded)
      resources = $resources
    }
  }
}
[pscustomobject]@{ realTimeProtection = [bool]$realtime; cuaHits = @($hits) }`;
  try {
    const out = await ps(script);
    if (!out) return { available: true, error: "no output" };
    return JSON.parse(out);
  } catch (error) {
    return { available: true, error: String(error?.message ?? error) };
  }
}

async function officialBinary() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("prepare-cua-win requires Windows x64");
  const cache = join(root, "node_modules", ".cache", "openmausbot", `cua-driver-${release.version}-win`);
  const cachedBinary = join(cache, "cua-driver.exe");
  if ((await binaryVersion(cachedBinary)) === expectedVersion) return cachedBinary;

  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.file}`;
  console.log(`Downloading CUA Driver ${release.version} from the official release…`);
  const response = await fetch(url, {
    headers: { "user-agent": "OpenMausBot-packager" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`CUA Driver download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`CUA Driver checksum mismatch: expected ${release.sha256}, got ${digest}`);
  }
  const archive = join(cache, release.file);
  await writeFile(archive, bytes);
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:OMB_CUA_ARCHIVE -DestinationPath $env:OMB_CUA_EXTRACT"], {
    env: { ...process.env, OMB_CUA_ARCHIVE: archive, OMB_CUA_EXTRACT: cache },
    timeout: 60_000,
    windowsHide: true,
  });

  // Post-extraction inspection: classify what Expand-Archive left behind before
  // trusting (or re-checking) the executable. Logged on every run so a
  // disappearance is visible instead of mysterious.
  const extracted = await inspectExtractedBinary(cache);
  console.log(`CUA extraction inspected: present=${extracted.present} regularFile=${extracted.regularFile} size=${extracted.size ?? "n/a"} sha256=${extracted.sha256 ?? "n/a"}`);
  if (!extracted.present) {
    throw new Error(
      `CUA executable missing after extraction: expected ${extracted.candidate} to be extracted from ${release.file}; ` +
      "the archive member or destination path may not match this runner's Expand-Archive behaviour",
    );
  }
  if (!extracted.regularFile) {
    throw new Error(
      `CUA executable is not a regular file after extraction: ${extracted.candidate} (size ${extracted.size})`,
    );
  }

  // Re-check presence immediately before validation: Defender or another
  // filesystem actor can delete a newly extracted unsigned executable
  // asynchronously. A disappearance here is distinct from a bad binary.
  const rechecked = await inspectExtractedBinary(cache);
  if (!rechecked.present) {
    const signal = await defenderSignalFor(cache);
    const evidence = signal.cuaHits?.length
      ? `; Windows Security recorded ${signal.cuaHits.length} cua-driver-related threat/detection record(s)`
      : "";
    throw new Error(
      `CUA executable disappeared after extraction: ${rechecked.candidate} was present immediately after Expand-Archive ` +
      `but missing before validation${signal.error ? ` (Defender signal unavailable: ${signal.error})` : ""}${evidence}. ` +
      "This is a filesystem-interference signal, not a confirmed Defender attribution.",
    );
  }
  if ((await binaryVersion(cachedBinary)) !== expectedVersion) {
    throw new Error(`downloaded CUA Driver does not report version ${expectedVersion}`);
  }
  return cachedBinary;
}

const isEntryPoint = (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  async function main() {
    let binary;
    if (process.env.CUA_DRIVER_PATH) {
      const suppliedVersion = await binaryVersion(process.env.CUA_DRIVER_PATH);
      if (suppliedVersion !== expectedVersion) {
        throw new Error(
          `CUA_DRIVER_PATH must point to cua-driver ${expectedVersion}; found ${suppliedVersion ?? "an unreadable binary"}`,
        );
      }
      binary = process.env.CUA_DRIVER_PATH;
    } else {
      const nativePackage = join(dependencyRoot, "@trycua", "cua-driver-win32-x64-msvc");
      if (!existsSync(nativePackage)) {
        throw new Error(
          `required CUA win32-x64 native package is missing — is pnpm.supportedArchitectures.cpu set in package.json?`,
        );
      }
      const candidate = join(realpathSync(nativePackage), "cua_driver.exe");
      if (!existsSync(candidate)) {
        binary = await officialBinary();
      } else {
        binary = candidate;
      }
    }

    if ((await binaryVersion(binary)) !== expectedVersion) {
      throw new Error(`CUA executable must match SDK ${expectedVersion}`);
    }
    const details = await stat(binary);
    if (!details.isFile()) {
      throw new Error(`cua-driver is not a file: ${binary}`);
    }

    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    await copyFile(binary, join(stage, "cua-driver.exe"));
    await writeFile(join(stage, "cua-driver-background.exe"), createBackgroundExecutable(await readFile(binary)));

    const nativeDir = join(stage, "cua-sdk", "native");
    const winNativePackage = join(dependencyRoot, "@trycua", "cua-driver-win32-x64-msvc");
    if (!existsSync(winNativePackage)) {
      throw new Error(
        `required CUA win32-x64 native package is missing`,
      );
    }
    await mkdir(nativeDir, { recursive: true });
    await Promise.all([
      copyFile(join(realpathSync(winNativePackage), "cua_driver_sdk.dll"), join(nativeDir, "cua_driver_sdk.dll")),
      copyFile(join(realpathSync(winNativePackage), "cua_driver_node_runtime.node"), join(nativeDir, "cua_driver_node_runtime.node")),
    ]);

    const bundle = join(stage, "cua-sdk", "cua-sdk.mjs");
    await build({
      stdin: {
        contents: [
          'export { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";',
        ].join("\n"),
        resolveDir: root,
        sourcefile: "openmausbot-cua-entry.mjs",
        loader: "js",
      },
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      banner: {
        js: 'import { createRequire as __openmausbotCreateRequire } from "node:module"; const require = __openmausbotCreateRequire(import.meta.url);',
      },
      outfile: bundle,
      logLevel: "silent",
    });
    // The SDK resolves its native library through @ubjs at runtime; the bundled
    // resolver is patched so OPENMAUSBOT_CUA_SDK_LIBRARY (the staged DLL) wins over
    // node_modules lookups that do not exist in the packaged app.
    const bundledSource = await readFile(bundle, "utf8");
    const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
    const resolvers = bundledSource.match(resolverPattern) ?? [];
    if (resolvers.length !== 1) {
      throw new Error("could not patch the bundled CUA native-library resolver");
    }
    await writeFile(
      bundle,
      bundledSource.replace(
        resolverPattern,
        `${resolvers[0]}\n      if (process.env.OPENMAUSBOT_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.OPENMAUSBOT_CUA_SDK_LIBRARY);`,
      ),
    );

    console.log(`Staged CUA for win32-x64 from ${binary}`);
  }

  await main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
