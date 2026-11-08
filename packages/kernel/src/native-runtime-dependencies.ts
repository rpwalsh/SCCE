// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/** Module identities required by the native emitter, checked again by the installed toolchain. */
export const GO_PROGRAM_STANDARD_LIBRARY = {
  source: ["fmt", "math", "math/big", "reflect", "sort", "strconv", "strings", "sync", "unicode/utf16"],
  test: ["testing"]
} as const;
