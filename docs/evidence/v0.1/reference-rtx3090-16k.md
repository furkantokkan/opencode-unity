# Evidence: `nvidia-24gb-qwen3-coder-30b-16k` on the reference machine

First measurement of the 16K reference preset for the 0.1.0-preview.1 release gate, run 2026-09-18.
Raw per-run data: [reference-rtx3090-16k.json](reference-rtx3090-16k.json).

## Configuration

| Configuration | Value |
|---|---|
| Machine | Windows 11 Pro build 26200, x64 |
| GPU | NVIDIA GeForce RTX 3090, 24576 MiB, driver 616.56 |
| Ollama | 0.34.1, dedicated server with the preset environment: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1` |
| Model tag | `ocu-qwen3-coder-30b-16k`, built from `templates/ollama/Modelfile.tpl` with the preset values (`FROM qwen3-coder:30b`, renderer and parser `qwen3-coder`, `num_ctx` 16384, `num_batch` 256, temperature 0.7, top_p 0.8, top_k 20, repeat_penalty 1.05) |
| API path | `/api/chat`, non-streaming, tools supplied for the tool-call runs |
| Machine load | Desktop applications and three idle Unity 6000.3 editors held about 5.4 GiB of video memory; the model loaded 100 % onto the GPU and about 180-200 MiB stayed free while it was resident |

## Method

Ten tool-call prompts (read a named file, or run a compile check, from a three-tool schema) and six
small edit instructions against a 24-line `Player.cs`, each run once, temperature 0.7, at 16K context
over `/api/chat`. A tool-call run passes when the response carries a native `tool_calls` entry with
the expected tool and arguments. A run that answered with the correct call written as text was counted
separately: the response text then contains the `<function=` marker the plugin's text-call detection
reports. An edit run passes when the returned file text makes exactly the requested change.

A first attempt with a cold model load died at run 8 with `CUDA error: out of memory`: the machine had
about 18.4 GiB free before the load and the resident model left about 200 MiB, so any extra allocation
could fail. This is the failure the GPU guard exists to prevent — with 18.4 GiB free the guard's
estimate for this preset would have refused the load. The series above was then completed without an
error; the raw file records the completed series.

## Results

| Series | Passed | Runs | Note |
|---|---|---|---|
| Tool calls, native `tool_calls` | 3 | 10 | In the other 7 runs the model picked the correct tool and arguments but wrote the call as `<function=...>` text; the plugin detects this and toasts, and the step does nothing |
| Tool-call runs with the correct call as text | 7 | 10 | Not executed; counted separately, not as passes |
| Edits (return the changed file) | 6 | 6 | Includes a field rename, a default change, added movement, a class rename |

Throughput across the 16 runs averaged 136 tok/s (generation only, as reported by Ollama), at 16K
context over `/api/chat` with a q8_0 KV cache; prompts were about 110-460 tokens.

## What this means

The model fits and runs on the reference card, and its small-file edits were reliable in this series.
Its tool calls are the weak point: most arrive as text the Ollama `qwen3-coder` parser does not turn
into a native call (the parser enters tool mode only on a literal `<tool_call>`), so in a session the
plugin's text-call toast is expected to appear often. The 32K preset stays experimental: its only
full-series runs ended with a CUDA error and a driver hang.
