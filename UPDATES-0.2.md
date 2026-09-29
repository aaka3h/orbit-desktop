# Orbit 0.2 — models that fit, readable text, and your theme

## 1. Explore models from Hugging Face

Open **Model Hub**. Orbit reads your computer's CPU, available RAM, and GPU details locally. It then shows public Hugging Face GGUF models and the available file sizes. Starter suggestions include small Qwen3 models from the Unsloth community repositories.

The model cards use real repository metadata. A **Good fit** label means the file should fit the conservative memory estimate. It does not mean the model's speed, accuracy, vision, tool support, or license has been verified. Open the model card to review the publisher's license and intended use.

Choose a model, review its file size and memory estimate, and click **Download**. This downloads through the Ollama service on your computer at `127.0.0.1:11434`. Public local models need no Hugging Face login. Orbit shows progress and lets you stop. Ollama may retain partial data for a later attempt. The app never downloads a multi-gigabyte model automatically.

After it finishes, choose **Use model** to select it for Orbit's local agent. Model support depends on your installed Ollama version and the model's chat/tool template. Small models may struggle with complex agent tasks. For screenshots, use a vision-capable model; these starter Qwen3 text models cannot see your screen.

The built-in downloader supports complete single-file GGUF models at the repository root. Split shards and vision projector files are excluded. Gated/private repositories need separate access setup in Hugging Face and Ollama.

## 2. Understand the hardware estimate

1. CPU and system memory come from your operating system.
2. GPU names and memory use available driver tools. Missing GPU details appear as unknown, never an invented number.
3. Orbit estimates model memory as file size × 1.1, plus the larger of 2 GiB or file size × 0.2 for context/runtime overhead.
4. It reserves 2–4 GiB from currently available RAM for other work. The estimate assumes approximately 4,000 context tokens; longer conversations and some architectures need more memory.
5. Dedicated GPU memory is considered separately. Apple unified memory is counted once. Multiple GPUs are not automatically combined. GPU compatibility and current free VRAM are not confirmed by this check.

Hardware details stay in the desktop app. Hugging Face receives model search/repository requests, not your hardware report. Refresh the hub after closing memory-heavy applications.

On the development computer, Orbit detected an Intel i7-13650HX, about 23.2 GiB system RAM, and an RTX 4060 Laptop GPU with about 8 GiB VRAM. The `unsloth/Qwen3-4B-GGUF` Q4_K_M file is about 2.3 GiB; Orbit estimates about 4.6 GiB runtime memory and classifies it as comfortable on that machine. This is a sizing estimate, not a generation-speed benchmark.

## 3. Change appearance

Open **Settings → Appearance**.

- **System** follows the operating system's light/dark choice, including changes while Orbit is open.
- **Light** or **Dark** keeps your selected theme.
- **Normal**, **Large**, and **Extra Large** change the interface text size.

Settings are saved on your computer and restored after restarting. The home page stays simple: navigation, a heading, a prompt field, and model/workspace controls.

## 4. Connect accounts honestly

- **ChatGPT:** uses the supported official Codex CLI account sign-in. The CLI manages credentials and subscription access. Orbit does not scrape browser sessions.
- **Hugging Face local models:** public downloads work without signing in.
- **Hugging Face Cloud:** uses HF Inference Providers with your access token and inference permission. It runs on remote infrastructure and may use paid credits. Available models and tool support vary.
- **Hugging Face browser sign-in:** device-login support is implemented. A distributed release needs the publisher's own registered public OAuth client ID. This development build has no registered client ID, so it offers the token connection. Website login alone does not authenticate Orbit.
- **Claude and Gemini:** the official app buttons open their websites for direct use. These external chats are separate from Orbit's agent. Orbit's integrated engines use the provider's API credentials; logging into a chat subscription does not automatically grant third-party API access.

Cloud requests can contain your prompts, relevant file content, and approved screenshots. Keys and OAuth tokens stay in the Electron main process and use the existing secure-storage behavior.

## 5. Configure browser login when publishing Orbit

1. Register your own **public OAuth application without a client secret** in Hugging Face settings.
2. Set `ORBIT_HF_CLIENT_ID` in the environment used to launch Orbit. The device flow requests only `profile inference-api`.
3. Test sign-in through the app. HF shows a code and consent screen; Orbit polls at the provider's permitted interval and saves only a verified token.
4. Expired tokens require reconnecting; this version does not persist OAuth refresh tokens. Do not ship another application's client ID or a client secret.

Official references: [Hugging Face model use with Ollama](https://huggingface.co/docs/hub/ollama), [HF device sign-in](https://huggingface.co/docs/hub/oauth), [HF cloud chat API](https://huggingface.co/docs/inference-providers/tasks/chat-completion), [Ollama model downloads](https://docs.ollama.com/api/pull), and [Codex App Server](https://learn.chatgpt.com/docs/app-server).
