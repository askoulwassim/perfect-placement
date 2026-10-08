# Kev setup (local System One backend, MLX on Apple Silicon)

Kev is the open-weights System One model (Apache-2.0, Qwen-based, https://github.com/jaredpalmer/kev). It serves the same `POST /v1/systemone` API as Jev, so the resolver uses one adapter for both and only switches the base URL. Kev is the fallback when Jev is unreachable and the default for open-source installs.

Source: the Kev README (checked 2026-10-08). Nothing here was run as part of lane I: no weights were downloaded.

## 1. Prerequisites

- Apple Silicon Mac. Memory guide from the README:

  | Model | Apple Silicon | Memory |
  | --- | --- | --- |
  | `kev-0.8b` | any Mac | ~4 GB |
  | `kev-4b` (recommended) | 32 GB Mac | 8 GB+ |
  | `kev-9b` | 32 GB+ Mac | ~17 GB |
  | `kev-27b` | 96 to 128 GB Mac | ~51 GB weights |

- Python 3.12 or 3.13 and `uv` (`brew install uv`). MLX is installed by the `serve` extra.
- Disk: the first run downloads the base model and adapter from Hugging Face (several GB for 4B).

## 2. Install

```sh
git clone https://github.com/jaredpalmer/kev.git ~/src/kev
cd ~/src/kev
uv sync --extra serve
```

## 3. Run kev-4b

```sh
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b@v1.0 --port 8009
```

- `--run` takes a Hub id, a local path, or a pinned revision (`@v1.0`). Pin it so evals are reproducible.
- Binds to `127.0.0.1` by default. Keep it that way: the resolver only needs localhost.
- Optional: `KEV_API_KEY=<random>` makes Kev require a bearer token. Export the same value in the shell that runs `pp`; the resolver sends it automatically.
- Do not set `KEV_TEMPERATURE=1.0` in normal use: it returns uncalibrated probabilities, and the policy assumes calibrated p.

## 4. Check it

```sh
curl -s localhost:8009/v1/models
curl -s localhost:8009/v1/systemone -H 'content-type: application/json' -d '{
  "state": "Thank you for applying. We received your application.",
  "model": "kev-latest",
  "questions": { "class": { "type": "choice", "instructions": "What is this email?",
    "criteria": { "confirmation": null, "rejection": null, "other": null } } }
}'
```

Expect `answers.class.choice = "confirmation"` with `probabilities` and `confidence`.

## 5. Point Perfect Placement at it

`$PP_HOME/config.json`:

```json
{ "backends": { "default": "jev", "fallback": "kev", "kev": { "baseUrl": "http://127.0.0.1:8009" } } }
```

For an install without a Jev key, set `"default": "kev"` (the resolver skips Jev anyway when `JEV_API_KEY` is unset). Settings shows Kev as reachable when `GET /v1/models` answers.

## 6. Keep it running (optional)

A user LaunchAgent (`~/Library/LaunchAgents/ai.kev.serve.plist`) with `ProgramArguments` set to the `uv run ...` command above, `WorkingDirectory` set to the clone, and `KeepAlive` true. Wave 2 decides whether `pp up` starts Kev itself.

## 7. Evaluate against Jev and the LLM

```sh
pnpm --filter @perfect-placement/resolver build
node packages/resolver/dist/eval/cli.js --live --backends jev,kev,llm \
  --v1 <path to v1 02_Pipeline> --rubric <path to v1 rubric.md> --out <a folder OUTSIDE the repo>
```

The CLI refuses to write v1-derived output inside the repo.
