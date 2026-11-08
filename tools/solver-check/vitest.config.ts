// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. See LICENSE.
import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

export default defineConfig({ ...base, test: { ...base.test, include: ["tools/solver-check/*.test.ts"] } });
