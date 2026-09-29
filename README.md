# Orbit — a desktop AI assistant

Orbit 0.2 includes a Hugging Face Model Hub, hardware fit estimates, readable text sizes, and system/light/dark themes. See [the update guide](UPDATES-0.2.md).

Orbit is a working first version of a desktop agent for **macOS, Windows, and Linux**. It runs its tools on your computer. Choose a local model, an API provider, or the official Codex engine with ChatGPT sign-in.

It can inspect a folder, read and write text files, fetch web pages, run commands, and optionally use your mouse, keyboard, and screenshots. Its abilities depend on the model, installed tools, operating-system permissions, and your approvals. It does not promise to perform every possible task.

## Screenshots

**Dark workspace:** start a task, choose an AI connection, and select a working folder.

![Orbit desktop workspace in dark mode, showing task suggestions, model selection, and the task composer](docs/screenshots/workspace-dark.png)

<details>
<summary>Light theme and larger text</summary>

The same workspace in light mode with larger text. Appearance can follow your system or use your preferred theme.

![Orbit desktop workspace in light mode with larger text and readable task controls](docs/screenshots/workspace-light.png)

</details>

<details>
<summary>Hugging Face Model Hub and hardware estimates</summary>

Model Hub shows detected hardware, available model files, download sizes, and memory-fit estimates. The hardware shown is one example; your computer's results will differ.

![Orbit Model Hub showing detected CPU, RAM and GPU, Hugging Face model choices, and a Qwen3 model file with a memory-fit estimate](docs/screenshots/model-hub.png)

</details>

These screenshots were captured from the running Linux desktop app.

## 1. Run the desktop app

Install [Node.js 24 LTS](https://nodejs.org/) first. Open a terminal in this project folder and run:

```sh
npm ci
npm run build
npm start
```

`npm ci` installs the exact dependencies in the lock file. `npm run build` compiles the interface and desktop program. `npm start` opens Orbit.

For development, use `npm run dev`. For a browser-only visual preview, use `npm run preview`; browser previews cannot access your computer or run the agent.

## 2. Try the built-in demonstration

1. Open **Settings** and choose a workspace folder. This is the folder the file tools can access.
2. Select **Demo** and save. This is a clearly labeled scripted demonstration, not a language model.
3. Enter a task and send it. Orbit lists your workspace and requests approval to create `orbit-demo.md`.
4. Inspect the proposed file contents, then approve or deny. The result reflects your decision.

This tests the real desktop bridge, agent loop, approval system, and file writing without an API key.

## 3. Connect a local model

1. Install [Ollama](https://ollama.com/).
2. If Ollama is not already running, run `ollama serve`.
3. Open **Model Hub** in Orbit. It detects CPU, available RAM, and GPU information, then shows starter Hugging Face models with conservative memory estimates.
4. Choose a model and its GGUF file. Review the download size, fit explanation, and model card, then click **Download**. Public models need no account. The download starts only after your click.
5. When it finishes, select **Use this model**. Select a workspace and send a task. You can also select an already installed Ollama model through **Settings → AI connection**.

The Hub downloads complete single-file GGUF models through local Ollama. The fit label estimates memory; it is not a speed benchmark or a guarantee of tool support. See [hardware estimates and account setup](UPDATES-0.2.md).

The model runs locally. Model downloads require internet, and web tools still contact websites. Tool quality and speed depend on your model and hardware. Desktop screenshots require a **vision-capable model with tool support**; a text-only model cannot understand screenshots.

For LM Studio or another OpenAI-compatible server, select **OpenAI compatible**, use its base URL (often `http://localhost:1234/v1`), and enter its exact loaded model ID. Compatibility varies by server and model.

## 4. Connect cloud APIs or a subscription

For **Hugging Face Cloud**, select it in Settings and enter your HF access token with inference permission and a supported model ID. Public local model downloads do not need this token. Browser sign-in support requires the publisher's own registered HF OAuth client ID; this development build has no registered client and uses the token connection. Cloud inference may use paid credits.

1. **OpenAI, Claude, or Gemini API:** select the provider, enter your own API key and an available model ID, test, then save. API usage may have separate billing; a chat subscription is not automatically an API key.
2. **ChatGPT subscription:** install the [official Codex CLI](https://learn.chatgpt.com/docs/cli), then choose **ChatGPT subscription (Codex)** and sign in. Orbit uses the documented Codex App Server; Codex itself owns the login and tokens. The account must have supported Codex access. You can leave the model blank to use its default. This experimental integration uses Codex's own tools, a read-only sandbox, and surfaced approval requests. Its configured plugins and MCP integrations retain their own permission behavior. It is separate from Orbit's local/API tool loop. Codex may run trusted reads without asking; escalations appear for approval. Existing CLI configuration or version differences can affect availability.
3. **Claude subscription:** use the official, unmodified Claude Code application directly with its own sign-in. Orbit does not collect Claude subscription tokens or proxy them. Orbit's built-in Claude engine uses an API key.
4. **Google subscription:** use Google's current official product directly. Orbit's integrated Gemini engine uses a Gemini API key. Consumer Gemini CLI access changed in 2026; do not assume an AI Pro/Ultra plan supplies third-party API access.

Connection tests list models or inspect sign-in; they do not prove a particular model supports tools or that your account has generation quota. Model names are editable because availability changes.

Official references, checked September 29, 2026:

- [Codex authentication](https://learn.chatgpt.com/docs/auth) and [App Server integration](https://learn.chatgpt.com/docs/app-server).
- [Claude Code terms and authentication restrictions](https://code.claude.com/docs/en/legal-and-compliance).
- [Google consumer CLI deprecation](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals), [Antigravity CLI](https://antigravity.google/docs/cli/install/), and [Antigravity terms](https://antigravity.google/terms).

## 5. Let Orbit use your computer

File tools work immediately after selecting a folder. Enable **Command access** for terminal tasks. Every command is shown for approval and starts in your workspace, but it runs with your account's permissions and can affect other folders too.

For optional mouse, keyboard, and screenshot tools:

1. Install Python 3. Create a dedicated environment in a folder of your choice:

   **macOS / Linux**
   ```sh
   python3 -m venv .orbit-desktop-tools
   .orbit-desktop-tools/bin/python -m pip install PyAutoGUI==0.9.54 Pillow
   ```

   **Windows PowerShell**
   ```powershell
   py -m venv .orbit-desktop-tools
   .\.orbit-desktop-tools\Scripts\python.exe -m pip install PyAutoGUI==0.9.54 Pillow
   ```

2. In Settings, set **Python executable** to the absolute path of that environment's Python executable and enable desktop access.
3. On macOS, grant Accessibility and Screen Recording permissions to the relevant Python/terminal application when requested. On Linux, use an **X11 desktop session** with a Pillow build that includes XCB support; see [Pillow screen capture](https://pillow.readthedocs.io/en/stable/reference/ImageGrab.html); Wayland is not supported by this helper. Windows runs at the current user's privilege level; it cannot control elevated windows reliably.
4. Select a vision-capable model and ask Orbit to take a screenshot before acting. Review each requested action. Orbit hides its own window briefly while observing or controlling the underlying app, then returns without taking focus.
5. To interrupt, click **Stop**, press **Ctrl+Alt+Shift+O** (Cmd+Alt+Shift+O on macOS, if the OS allows registration), or move the pointer to a screen corner to trigger PyAutoGUI's fail-safe.

This first version supports the primary monitor, clicks, ASCII typing, keys, shortcuts, scrolling, and screenshots. It does not include full browser DOM automation, background desktop sessions, voice, mobile control, or a bundled Python runtime. Avoid interacting with another application while an approved mouse/keyboard action executes. See [PyAutoGUI platform and monitor limits](https://pyautogui.readthedocs.io/en/latest/).

## 6. Understand what stays local

1. The interface, task history, file tools, and execution run on your computer. History and settings are stored in Electron's per-user Orbit data directory.
2. API keys stay in the main process. Electron's operating-system secret storage encrypts them when available. If secure storage is unavailable, keys remain in memory for this app session and must be entered again after restarting; they are never saved as plain text.
3. Task history is stored as readable local JSON. File contents may be included in conversation context. Screenshots are sent to the selected model during a task but are not saved in chat history.
4. Local/API file tools reject traversal, symbolic links, hard links, and common credential paths. Shell and desktop actions are not confined by the file-tool checks.
5. Every write, web request, command, and desktop action requires approval. Cancellation stops pending model calls and processes where possible; already completed actions are not rolled back. Approvals are decisions about the displayed action, not a guarantee that it is harmless.
6. A cloud provider receives the prompt and relevant tool results, including any approved screenshots. Choose a local endpoint for local model processing. The Codex engine uses its own official account and storage behavior.

## 7. Build for each operating system

```sh
npm run dist:linux
npm run dist:win
npm run dist:mac
```

Build on the matching operating system for the most reliable result. Linux targets a portable AppImage; Windows targets an NSIS installer; macOS targets DMG and ZIP. Build outputs appear in `release/0.2.0/`.

The Windows development installer does not edit or sign the executable. Configure signing and set `win.signAndEditExecutable` to `true` for a branded production release.

The included `.github/workflows/build.yml` builds and tests on all three systems when manually run or when a `v*` tag is pushed. It does not publish artifacts automatically.

Release signing and macOS notarization require the owner's certificates. The supplied development builds are unsigned. Build configuration alone is not evidence that an app has been tested on every platform.

## 8. Verify and extend the app

```sh
npm test
npm run typecheck
npm run build
```

- `src/` contains the React interface.
- `electron/main.ts` owns the desktop window and validated bridge calls.
- `electron/agent.ts` runs the bounded model/tool loop.
- `electron/providers.ts` translates the provider APIs and preserves provider tool state.
- `electron/tools.ts` implements approved local tools.
- `electron/codex.ts` integrates the official Codex App Server.
- `electron/hardware.ts` reads local hardware and estimates model memory fit.
- `electron/hub.ts` reads public Hugging Face metadata and downloads through local Ollama.
- `electron/hf-auth.ts` implements optional registered Hugging Face device login.
- `scripts/computer.py` implements optional desktop controls.
- `electron/store.ts` stores sessions and encrypted keys.

To add a capability, define its schema, implement it in the main process, decide when approval is required, and test the real boundary. Never give the renderer direct filesystem or shell access.
