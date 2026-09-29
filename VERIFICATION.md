# Verification — Orbit 0.2.0

Checked September 29, 2026, on Linux x64. Hardware recommendations are memory estimates, not generation benchmarks.

**79 automated tests pass.** They cover provider protocols and tool state, endpoint restrictions, cancellation, approval denial, workspace protection, agent step limits, hardware parsing and memory fit, consistent model recommendations, Hugging Face device login, malformed metadata, and download progress/cancellation. The separate live Llama grounding test fails as explained below.

## 1. Desktop behavior

1. TypeScript and production builds pass.
2. An actual Electron window opens the home page and exercises the offline demo: approval before writing, the expected file after approval, denial of a later action, desktop permission controls, and history persistence. No renderer exceptions were observed.
3. Appearance checks exercise 16/18/20 px base text, light/dark modes, saved preferences after reload, changes to the system preference while open, and the small-window layout.
4. Visual review caught and fixed a transient contrast issue during theme switching. Measured New task and suggestion text contrast exceeds 4.5:1 in both themes.

## 2. Hardware and Hugging Face

1. Actual local detection reports Intel i7-13650HX, 20 logical cores, about 23.2 GiB RAM, and an RTX 4060 Laptop GPU with about 8 GiB dedicated memory. Hardware is read locally; it is not uploaded to Hugging Face.
2. Actual public Hugging Face metadata loads in the Electron Model Hub. File selection shows real sizes and computed fit estimates. The Qwen3-4B Q4_K_M file is about 2.3 GiB, with about 4.6 GiB estimated runtime memory.
3. The GUI test verifies that opening and browsing the Hub never starts a model download.
4. Hardware parsers, conservative memory budgeting, model metadata validation, registered-account device login, cloud request formatting, and download cancellation are tested with controlled fixtures. Platform parser tests are not native Windows/macOS hardware tests.
5. No multi-gigabyte Hugging Face model was downloaded or benchmarked. Download protocol and cancellation use mocked streams. Actual end-to-end Hub download and generation remain unverified.
6. No cloud credentials were supplied. Live Hugging Face inference, Hugging Face OAuth, OpenAI/Anthropic/Gemini generation, and ChatGPT Codex login remain unverified. This development build has no registered Hugging Face OAuth client ID; its cloud connection uses a token.

## 3. Live local-model result: not reliable yet

The previous 0.1 test succeeded with the installed `llama3.1:latest`. In the 0.2 repeat, the model called `read_file` but gave an incorrect final answer. One diagnostic run confirmed all of the following:

1. The file tool returned the exact temporary fixture, including `BLUE-PINE-42`.
2. The next Ollama HTTP request carried those exact contents in the correct tool message.
3. The installed Llama 3.1 model still produced a generic response instead of reporting the marker. The final-answer assertion correctly failed.

No user documents were used or changed. This is a failed model-grounding check, not a successful end-to-end local-agent result. The diagnostic found no lost tool result in Orbit's transport. Model reliability must be checked for the chosen task; a memory-fit label cannot establish answer quality or tool competence.

The local smoke script retains its strict final-answer assertion and now separately verifies file contents, wire delivery, and the unchanged fixture. Tests were not weakened or retried until green.

## 4. Desktop control and platform limits

1. Version 0.2 packages were generated for Linux x64 (AppImage), Windows x64 (NSIS), and macOS Intel/Apple Silicon (ZIP). The packaged Linux executable launches, reports version 0.2.0 through its bridge, and contains the external Python helper.
2. The Model Hub was additionally checked at extra-large text in a small window: its content scrolls vertically and has no horizontal overflow.
3. The Python helper's screenshot, click, ASCII typing, keys, shortcuts, and scroll previously passed on an isolated Linux X11 display. No actions were performed on the user's active desktop. These helper paths are unchanged in 0.2.
4. End-to-end vision-model desktop tasks, macOS Accessibility/Screen Recording permission handling, Windows elevated windows, and multi-monitor workflows remain unverified. The helper does not support Wayland.
5. Development packages are unsigned. Native macOS/Windows runtime testing, release signing/notarization, auto-update, and OS-store distribution remain outstanding.

## 5. Reproduce

1. Run `npm ci`, `npm test`, and `npm run build`.
2. On a graphical Linux desktop, run `npm run smoke`. Headless: `xvfb-run -a npm run smoke`.
3. Run `xvfb-run -a node scripts/appearance-smoke.mjs` for themes, text size, real hardware, and live HF metadata. It requires internet for metadata, but downloads no models.
4. With Ollama and `llama3.1:latest` available, run `npm run test:local`. The current model may fail the grounding assertion as documented above. `ORBIT_SMOKE_MODEL` selects a different installed tool-capable model; `ORBIT_SMOKE_TRACE` optionally writes a synthetic-fixture diagnostic trace.
5. After Linux packaging, run `xvfb-run -a node scripts/package-smoke.mjs`.
