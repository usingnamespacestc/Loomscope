// Loomscope backend module surface.
//
// `cli.ts` is the actual entry binary (boots `serve()`). This file just
// exports the building blocks — `createApp`, `parseArgs` — so tests and the
// CLI both pull from a single source.

import * as os from "node:os";
import * as path from "node:path";

import { Command } from "commander";

export { createApp } from "@/server/app";

export interface CliOptions {
  port: number;
  bind: string;
  rootDir: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name("loomscope-server")
    .description("Loomscope backend (Hono)")
    .option("-p, --port <port>", "port to listen on", "5174")
    .option("--bind <addr>", "bind address (127.0.0.1 by default; 0.0.0.0 = Mode B)", "127.0.0.1")
    .option(
      "--root <dir>",
      "override CC projects dir",
      path.join(os.homedir(), ".claude", "projects"),
    )
    .exitOverride();
  program.parse(argv, { from: "user" });
  const opts = program.opts();
  return {
    port: Number(opts.port),
    bind: String(opts.bind),
    rootDir: String(opts.rootDir ?? opts.root),
  };
}
