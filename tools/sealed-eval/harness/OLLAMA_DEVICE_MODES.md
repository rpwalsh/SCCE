# Ollama device mode probe

`ollama-device-mode.ps1` is a local evidence probe for `qwen2.5:3b`. It starts a
temporary Ollama server with an explicit mode, sends one deterministic health
request to load the model, records the model digest and residency evidence, and
then restores a plain local `ollama serve`. It never writes generated text or
benchmark answers.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sealed-eval\harness\ollama-device-mode.ps1 -Mode cpu -OutFile .tmp\ollama-cpu.json
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sealed-eval\harness\ollama-device-mode.ps1 -Mode vulkan -OutFile .tmp\ollama-vulkan.json
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\sealed-eval\harness\ollama-device-mode.ps1 -Mode npu -OutFile .tmp\ollama-npu.json
```

Exit code `0` means the requested CPU or Vulkan mode was verified. Exit code
`2` means the request was rejected or unverified. The NPU probe intentionally
returns `2` even when Windows reports an `Intel(R) AI Boost` device: the Ollama
server has no NPU backend or NPU selector, so hardware presence cannot be
reported as NPU residency.

The CPU server uses `OLLAMA_LLM_LIBRARY=cpu_avx2`, `OLLAMA_VULKAN=0`, and
`GGML_VK_VISIBLE_DEVICES=-1`. The Vulkan server uses `OLLAMA_VULKAN=1`,
`OLLAMA_IGPU_ENABLE=1`, and `GGML_VK_VISIBLE_DEVICES=0`; the probe accepts the
GPU claim only when `ollama ps`, `/api/ps`, `vulkaninfo`, and the Ollama server
log agree on an Intel Arc Vulkan residency.

The settings and checks follow the official Ollama references:

- [LLM library override](https://github.com/ollama/ollama/blob/main/docs/troubleshooting.mdx#experimental-llm-library-override)
- [Vulkan GPU support and device selection](https://github.com/ollama/ollama/blob/main/docs/gpu.mdx#vulkan-gpu-support)
- [GPU residency in `ollama ps`](https://github.com/ollama/ollama/blob/main/docs/faq.mdx#how-can-i-tell-if-my-model-was-loaded-onto-the-gpu)
- [`/api/ps` running model response](https://github.com/ollama/ollama/blob/main/docs/api.md#list-running-models)
- [Ollama Intel NPU feature request](https://github.com/ollama/ollama/issues/3004)
