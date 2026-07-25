import { z } from 'zod';

/** A caller-supplied JSON schema is advertising, not enforcing — every tool call is re-validated here at runtime. */
export class ToolArgumentError extends Error {
  constructor(public readonly toolName: string, public readonly issues: string) {
    super(`invalid arguments for ${toolName}: ${issues}`);
    this.name = 'ToolArgumentError';
  }
}

const boundedInt = (min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback);

const boundedString = (max: number) => z.string().min(1).max(max);

/** Repo-relative path: no absolute paths, no parent-traversal segments, no null bytes. */
export const repoRelativePath = z
  .string()
  .max(500)
  .refine((value) => !value.includes('\0'), { message: 'path must not contain a null byte' })
  .refine((value) => !/^([A-Za-z]:)?[\\/]/.test(value), { message: 'path must be repository-relative, not absolute' })
  .refine((value) => !value.split(/[\\/]/).includes('..'), { message: 'path must not contain a ".." segment' });

/** SQL/Postgres bare identifier: letters, digits, underscore, not starting with a digit. */
export const sqlIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a bare SQL identifier');

/** Trace id: bounded, filesystem-safe token — never a path. */
export const traceId = z.string().max(128).regex(/^[A-Za-z0-9._-]+$/, 'must be a bounded filesystem-safe token');

export const toolSchemas = {
  repo_shape: z.object({}).strict(),
  repo_files: z.object({
    glob: boundedString(300).optional(),
    contains: boundedString(300).optional(),
    maxResults: boundedInt(1, 2000, 100)
  }).strict(),
  repo_search: z.object({
    query: boundedString(500),
    glob: boundedString(300).optional(),
    maxResults: boundedInt(1, 500, 50)
  }).strict(),
  repo_symbol: z.object({
    symbol: boundedString(300),
    maxResults: boundedInt(1, 200, 25)
  }).strict(),
  repo_callsites: z.object({
    symbol: boundedString(300),
    maxResults: boundedInt(1, 500, 50)
  }).strict(),
  repo_routes: z.object({}).strict(),
  repo_deps: z.object({}).strict(),
  repo_deadcode: z.object({}).strict(),
  git_changed: z.object({}).strict(),
  git_diff_summary: z.object({
    path: repoRelativePath.optional(),
    maxLines: boundedInt(1, 5000, 200)
  }).strict(),
  test_run: z.object({
    commandId: boundedString(64),
    filter: boundedString(300).optional(),
    maxOutputLines: boundedInt(1, 5000, 200)
  }).strict(),
  test_failures: z.object({
    commandId: boundedString(64),
    maxFailures: boundedInt(1, 200, 10)
  }).strict(),
  pg_schema: z.object({
    schema: sqlIdentifier.optional()
  }).strict(),
  pg_explain: z.object({
    sql: boundedString(20_000)
  }).strict(),
  scce_trace_list: z.object({
    limit: boundedInt(1, 500, 20)
  }).strict(),
  scce_trace_read: z.object({
    traceId: traceId.optional(),
    file: boundedString(200).regex(/^[A-Za-z0-9._-]+\.jsonl$/, 'must be a bare .jsonl filename').optional(),
    stage: boundedString(200).optional(),
    maxEvents: boundedInt(1, 5000, 100)
  }).strict(),
  scce_answer_trace: z.object({
    traceId: traceId.optional(),
    file: boundedString(200).regex(/^[A-Za-z0-9._-]+\.jsonl$/, 'must be a bare .jsonl filename').optional()
  }).strict()
} as const;

export type ToolName = keyof typeof toolSchemas;

export function validateToolArgs<T extends ToolName>(toolName: T, args: unknown): z.infer<(typeof toolSchemas)[T]> {
  const schema = toolSchemas[toolName];
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw new ToolArgumentError(toolName, result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  }
  return result.data as z.infer<(typeof toolSchemas)[T]>;
}
