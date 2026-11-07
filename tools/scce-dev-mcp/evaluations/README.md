<!-- SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved. -->
<!-- Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE. -->
# MCP tool-choice coding evaluation

Run `node tools/scce-dev-mcp/evaluations/qwen-mcp-coding.mjs` from the repository root after building the MCP server and starting the declared local reference endpoint. The runner requests Qwen 2.5:3b from that endpoint and unloads it when finished; it does not start the Ollama service.

The harness creates a scratch repository under `.tmp`, connects to the real MCP server over stdio, and builds a strict JSON Schema `oneOf` from the input schemas the server advertises. Each model response must be JSON containing exactly one advertised tool name and an argument object. The harness validates only that outer protocol envelope; the real MCP server remains authoritative for validating tool arguments and performing the action. Narrative text and native tool-call objects are not interpreted as actions.

The supplied regression tests are hashed before the run and must remain byte-for-byte unchanged. Success requires an actual passing `test_run` result plus independent held-out checks. The replay receipt is written to `.tmp/qwen-mcp-coding-jsonschema.json`; failed runs remain failures, with no fallback to parsing prose.

The receipt records the model digest, tool schemas, sampling settings, source hash, raw tool choices, and actual tool results. This single repair task does not establish general application-building ability.

This is an evaluation reference declared in `models.declared.json`. It is measurement-only and is not imported by product packages.
