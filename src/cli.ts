import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractLoadError, ContractStore } from "./contract-loader.js";
import { lintContracts } from "./contract-linter.js";
import { createLogger, parseBooleanEnv, resolveContractsDir } from "./security.js";

type ParsedCliArgs = {
  command: "init" | "validate" | "lint" | "help";
  contractsDir?: string;
  strict: boolean;
  json: boolean;
  force: boolean;
};

type InitResult = {
  contractsDir: string;
  sourceDir: string;
  copied: string[];
  skipped: string[];
};

function usage(): string {
  return [
    "json-contracts",
    "",
    "Usage:",
    "  json-contracts                 Start the stdio MCP server",
    "  json-contracts init            Copy starter contracts into ./json-contracts",
    "  json-contracts validate        Validate all contracts for CI",
    "  json-contracts lint            Validate and print advisory contract warnings",
    "  json-contracts lint --strict   Exit nonzero when lint warnings are found",
    "",
    "Options:",
    "  --contracts <dir>, -c <dir>    Contracts directory (default: JSON_CONTRACTS_DIR or ./json-contracts)",
    "  --force                        Overwrite existing files during init",
    "  --json                         Print machine-readable JSON for init/validate/lint",
    "  --help, -h                     Show this help"
  ].join("\n");
}

function parseArgs(args: string[]): ParsedCliArgs {
  const [commandArg, ...rest] = args;
  const command = commandArg === "init" || commandArg === "validate" || commandArg === "lint" ? commandArg : "help";
  if (commandArg === "--help" || commandArg === "-h" || commandArg === "help") {
    return { command: "help", strict: false, json: false, force: false };
  }

  if (command === "help") {
    throw new Error(`Unknown command: ${commandArg ?? ""}`.trim());
  }

  const parsed: ParsedCliArgs = {
    command,
    strict: false,
    json: false,
    force: false
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--contracts":
      case "-c": {
        const value = rest[index + 1];
        if (!value) throw new Error(`${arg} requires a directory path`);
        parsed.contractsDir = value;
        index += 1;
        break;
      }
      case "--strict": {
        parsed.strict = true;
        break;
      }
      case "--force": {
        parsed.force = true;
        break;
      }
      case "--json": {
        parsed.json = true;
        break;
      }
      case "--help":
      case "-h": {
        return { command: "help", strict: false, json: false, force: false };
      }
      default: {
        throw new Error(`Unknown option: ${arg}`);
      }
    }
  }

  return parsed;
}

function writeStdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

function writeStderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function formatLoadError(error: unknown): string[] {
  if (error instanceof ContractLoadError) {
    return [
      error.message,
      ...error.failures.map((failure) => `- ${failure.file}: ${failure.error.message}`)
    ];
  }

  return [error instanceof Error ? error.message : String(error)];
}

async function loadContracts(contractsDir: string, debug: boolean) {
  const store = new ContractStore({
    contractsDir,
    allowInvalidContracts: false,
    logger: createLogger(debug)
  });
  const contracts = await store.reload({ emitChange: false });
  return { store, contracts };
}

function starterContractsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../json-contracts");
}

async function initStarterContracts(contractsDir: string, force: boolean): Promise<InitResult> {
  const sourceDir = starterContractsDir();
  await mkdir(contractsDir, { recursive: true });

  const entries = await readdir(sourceDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".json") || entry.name === "LICENSE.md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const fileName of fileNames) {
    const sourceFile = path.join(sourceDir, fileName);
    const targetFile = path.join(contractsDir, fileName);

    try {
      await copyFile(sourceFile, targetFile, force ? 0 : fsConstants.COPYFILE_EXCL);
      copied.push(fileName);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (!force && nodeError.code === "EEXIST") {
        skipped.push(fileName);
        continue;
      }
      throw error;
    }
  }

  return { contractsDir, sourceDir, copied, skipped };
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    writeStderr(error instanceof Error ? error.message : String(error));
    writeStderr(usage());
    return 2;
  }

  if (parsed.command === "help") {
    writeStdout(usage());
    return 0;
  }

  const debug = parseBooleanEnv(env.DEBUG, false);
  const contractsDir = resolveContractsDir(parsed.contractsDir ?? env.JSON_CONTRACTS_DIR ?? "./json-contracts");

  if (parsed.command === "init") {
    try {
      const result = await initStarterContracts(contractsDir, parsed.force);
      if (parsed.json) {
        writeStdout(JSON.stringify({ initialized: true, force: parsed.force, ...result }, null, 2));
      } else {
        writeStdout(`Initialized starter contracts in ${contractsDir}.`);
        writeStdout(`Copied ${result.copied.length} file(s). Skipped ${result.skipped.length} existing file(s).`);
        if (result.copied.length > 0) writeStdout(`Copied: ${result.copied.join(", ")}`);
        if (result.skipped.length > 0) writeStdout(`Skipped: ${result.skipped.join(", ")}`);
        writeStdout("");
        writeStdout("Next:");
        writeStdout("  json-contracts validate --contracts ./json-contracts");
        writeStdout("  Add json-contracts to your MCP host config with JSON_CONTRACTS_DIR pointing at this folder.");
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.json) {
        writeStdout(JSON.stringify({ initialized: false, contractsDir, error: message }, null, 2));
      } else {
        writeStderr(`Failed to initialize starter contracts: ${message}`);
      }
      return 1;
    }
  }

  try {
    const { store, contracts } = await loadContracts(contractsDir, debug);
    try {
      if (parsed.command === "validate") {
        if (parsed.json) {
          writeStdout(JSON.stringify({ valid: true, contractsDir, loaded: contracts.length, contracts: store.listSummaries() }, null, 2));
        } else {
          writeStdout(`Validated ${contracts.length} contract(s) in ${contractsDir}.`);
          for (const contract of store.listSummaries()) {
            writeStdout(`- ${contract.name} ${contract.contractHash}`);
          }
        }
        return 0;
      }

      const warnings = lintContracts(contracts);
      const ok = !parsed.strict || warnings.length === 0;
      if (parsed.json) {
        writeStdout(
          JSON.stringify(
            {
              valid: true,
              ok,
              strict: parsed.strict,
              contractsDir,
              loaded: contracts.length,
              warnings
            },
            null,
            2
          )
        );
      } else {
        writeStdout(`Linted ${contracts.length} contract(s) in ${contractsDir}.`);
        if (warnings.length === 0) {
          writeStdout("No lint warnings.");
        } else {
          writeStdout(`${warnings.length} warning(s):`);
          for (const warning of warnings) {
            writeStdout(`- ${warning.contract} ${warning.path}: ${warning.message}`);
          }
        }
      }
      return ok ? 0 : 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    const details = formatLoadError(error);
    if (parsed.json) {
      writeStdout(JSON.stringify({ valid: false, contractsDir, errors: details }, null, 2));
    } else {
      writeStderr("Contract validation failed:");
      for (const detail of details) writeStderr(detail);
    }
    return 1;
  }
}
