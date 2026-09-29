# Install Orbit 0.3.0 beta

Orbit is a desktop AI assistant for Linux, Windows, and macOS. Follow the instructions for your operating system, then complete the first-run setup.

**Release status:** these are unsigned beta packages. The macOS packages are not notarized. Native builds and automated tests run in CI; interactive Windows/macOS installation remains unverified. Your operating system may warn about or block an unsigned app.

You do not need Node.js or npm to use a packaged Orbit app. Local AI models require a separate Ollama installation and model download.

## 1. Download the right file

1. Sign in to GitHub with an account that has access to **aaka3h/orbit-desktop**. This repository is private, so its release files also require access. If GitHub shows **404**, check your account and ask the repository owner for access.
2. Open the [Orbit v0.3.0 beta release](https://github.com/aaka3h/orbit-desktop/releases/tag/v0.3.0) and expand **Assets**. This is where the ready-to-use app packages are listed.
3. Choose the file for your computer:

   - **Linux, Intel/AMD 64-bit:** [Orbit-0.3.0.AppImage](https://github.com/aaka3h/orbit-desktop/releases/download/v0.3.0/Orbit-0.3.0.AppImage)
   - **Windows, Intel/AMD 64-bit:** [Orbit-Setup-0.3.0.exe](https://github.com/aaka3h/orbit-desktop/releases/download/v0.3.0/Orbit-Setup-0.3.0.exe)
   - **Mac with Apple Silicon:** [Orbit-0.3.0-arm64-mac.zip](https://github.com/aaka3h/orbit-desktop/releases/download/v0.3.0/Orbit-0.3.0-arm64-mac.zip)
   - **Mac with an Intel processor:** [Orbit-0.3.0-mac.zip](https://github.com/aaka3h/orbit-desktop/releases/download/v0.3.0/Orbit-0.3.0-mac.zip)

4. Keep the filename unchanged. The Linux commands below use that exact name. On a Mac, **Apple menu → About This Mac** identifies an Apple chip or Intel processor if you are unsure which ZIP to choose.
5. Follow only your operating system's installation section below.

The automatically generated **Source code (zip)** and **Source code (tar.gz)** downloads are project code, not installed apps. The optional **Orbit-0.3.0-source.zip** is also for developers. **SHA256SUMS.txt** contains file checksums for verifying downloads; it is not an installer.

## 2. Install on Linux

1. Download **Orbit-0.3.0.AppImage** to your **Downloads** folder. An AppImage is a portable app file, so there is no installation wizard.
2. Open a terminal and enter:

   ```sh
   cd ~/Downloads
   chmod +x Orbit-0.3.0.AppImage
   ./Orbit-0.3.0.AppImage
   ```

   `cd` opens the download folder. `chmod +x` allows the file to run as a program. The last command opens Orbit.

3. Keep the AppImage somewhere convenient. You can run the same file again; its data is stored separately in your user account.
4. If the terminal specifically reports a **FUSE** error, use this extraction fallback from the Downloads folder:

   ```sh
   mkdir -p orbit-0.3.0
   cd orbit-0.3.0
   ../Orbit-0.3.0.AppImage --appimage-extract
   ./squashfs-root/AppRun
   ```

   These commands make a folder, unpack the app, and run the unpacked copy. Keep the extracted folder if you want to launch `squashfs-root/AppRun` again. This fallback avoids needing FUSE; see the [official AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

5. Continue to **5. Choose a cloud or local model** below.

## 3. Install on Windows

1. Download **Orbit-Setup-0.3.0.exe** and open it from **Downloads**. This starts the installation wizard.
2. Follow the wizard, choose an installation location if prompted, and finish installation. The package is unsigned, so Windows may display a publisher or reputation warning. Check that the file came from the release linked above. If your organization's policy blocks it, ask your administrator.
3. Open **Orbit** from the Start menu, or use the launch option at the end of the wizard if shown.
4. Continue to **5. Choose a cloud or local model** below.

## 4. Install on macOS

1. Download the ZIP matching your Mac: **arm64** for Apple Silicon, or **Orbit-0.3.0-mac.zip** for Intel. The correct architecture lets the app use your Mac's processor.
2. In Finder, open **Downloads** and double-click the ZIP. This extracts **Orbit.app**.
3. Drag **Orbit.app** into **Applications**. Then open **Applications** and double-click **Orbit**.
4. This beta has no Developer ID signature or Apple notarization, so macOS may block it. Review [Apple's official guidance on safely opening downloaded apps](https://support.apple.com/en-us/102445). If the app reports that it is damaged or unsafe, stop and share the exact message with the repository owner.
5. Once Orbit opens, continue below. Native macOS operation still needs testing; packaging the app does not prove that it runs correctly on every Mac.

## 5. Choose a cloud or local model

For cloud AI, skip the local download steps and follow section 6. Once connected, open **Agents & skills → Browser**, enable Chrome or Edge and open the separate Orbit browser. Sign in manually to shopping or other websites, then select a bot. See [the agent setup guide](docs/AGENTS-AND-SKILLS.md).

For a local model:

1. Install [Ollama for your operating system](https://ollama.com/download). Ollama is the service that runs local AI models; Orbit provides the interface and task tools.
2. Start Ollama. On macOS or Windows, open its installed app. On Linux, if the service is not already running, enter `ollama serve` in a terminal and leave it running. See the [Ollama quickstart](https://docs.ollama.com/quickstart).
3. Open **Model Hub** in Orbit. It reads your computer's processor, memory, and graphics information to estimate which models may fit.
4. Select a model, review its file size and **Good fit / Tight fit** explanation, and click **Download**. Models can be several gigabytes. Public local models need no Hugging Face account. Downloads start only when you click.
5. When the download finishes, click **Use this model**. This connects Orbit to that model through local Ollama. Memory-fit labels are estimates, not speed benchmarks or guarantees of tool support.
6. Click **Choose workspace**, browse to a folder you want Orbit to work with, and save your setup. A small folder with a few non-sensitive text files is a useful first test.
7. Send a small task, such as: **“List the files in this folder and explain what is here. Do not change any files.”** This checks that the model and file tools work together before you request larger changes.
8. Review any action requiring approval. **Allow this action** permits the displayed operation; **Deny action** declines it. Use **Stop** to interrupt a task. Completed changes are not automatically undone.
9. Optionally open **Settings → Appearance** to choose **Follow system**, **Light**, or **Dark**, and a comfortable text size.

If Ollama cannot be reached, check that it is running and use **Settings → AI connection → Test connection**. If a task fails despite a successful connection test, check the model's tool support; small models may struggle with agent tasks.

## 6. Use an account or add desktop control

1. **Cloud APIs:** choose OpenAI, Anthropic, Gemini, or Hugging Face Cloud in **Settings → AI connection**. Enter your own API key or HF inference token, choose an available model, test, and save. Provider charges and account limits apply. A chat subscription is not automatically an API key.
2. **ChatGPT account:** the experimental subscription connection requires the official Codex CLI and an account with supported Codex access. Codex manages sign-in and connects to Orbit's approved tools through its experimental dynamic-tool interface. A local model is not required. See the [account setup instructions](https://github.com/aaka3h/orbit-desktop/blob/v0.3.0/README.md#4-connect-cloud-apis-or-a-subscription).
3. **Claude or Gemini subscriptions:** the **Open official app** buttons open those providers' websites. They do not connect those chat subscriptions to Orbit's agent tools. Integrated Claude and Gemini tasks use API keys.
4. **Hugging Face:** public local downloads need no account. Cloud inference accepts an access token. One-click browser sign-in needs publisher OAuth setup, which is not configured in this beta.
5. **Mouse, keyboard, and screenshots:** these are optional. Follow [the Python and operating-system permission steps](https://github.com/aaka3h/orbit-desktop/blob/v0.3.0/README.md#5-let-orbit-use-your-computer) before enabling desktop control. Screenshots need a vision-capable model and are sent to the selected model. Basic file tasks do not require this helper.

For source builds, tests, and detailed limitations, return to the [README](https://github.com/aaka3h/orbit-desktop/blob/v0.3.0/README.md).
