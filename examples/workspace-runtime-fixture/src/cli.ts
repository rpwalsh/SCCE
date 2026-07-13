import { listWidgets } from "./widget.js";

export function runCli(argv: string[]): number {
  if (argv.includes("--list")) {
    console.log(JSON.stringify(listWidgets()));
    return 0;
  }
  return 1;
}
