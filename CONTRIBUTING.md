# Contribute to Orbit

You can help Orbit without being an AI expert. Small, clear contributions are useful, and maintainers review changes before they become part of the project.

## 1. Choose something to improve

1. Look through [existing issues](https://github.com/aaka3h/orbit-desktop/issues) to see whether someone has already reported your idea or problem. This helps avoid duplicate work.
2. Help in a way that fits your experience: improve documentation, report a reproducible operating-system bug, add a regression test, suggest clearer translations, or improve keyboard access, screen-reader labels, and text contrast. Translation suggestions are welcome; a complete localization system is not currently included.
3. For a bug report, [open an issue](https://github.com/aaka3h/orbit-desktop/issues/new/choose). Include your Orbit version, operating system and version, CPU architecture, exact steps, expected result, and actual result. For browser problems, include the browser and version. Remove private data from screenshots and logs so other people can reproduce the problem safely.
4. Discuss a larger feature in an issue or [GitHub Discussions](https://github.com/aaka3h/orbit-desktop/discussions) before building it. Explain the problem and proposed behavior so maintainers can confirm that it fits the project.

## 2. Make your own copy of the project

1. Install **Git** and **Node.js 24 LTS**. Node includes npm, which installs the project's dependencies and runs its development commands.
2. Sign in to GitHub, open [aaka3h/orbit-desktop](https://github.com/aaka3h/orbit-desktop), and click **Fork**. A fork is your own GitHub copy; it lets you propose changes without changing the original repository.
3. Open a terminal and run the following commands. **Replace `YOUR-USERNAME` with your GitHub username before running the clone command.**

   ```sh
   git clone https://github.com/YOUR-USERNAME/orbit-desktop.git
   cd orbit-desktop
   git remote add upstream https://github.com/aaka3h/orbit-desktop.git
   git switch -c improve-workspace-help
   ```

   `clone` downloads your fork. `cd` opens its folder. `upstream` names the original repository. `switch -c` creates a branch for your change; use a short name describing your own work instead of `improve-workspace-help` if appropriate.

## 3. Install and run Orbit

1. From the project folder, install the exact dependency versions in the lock file:

   ```sh
   npm ci
   ```

2. Build the interface and desktop code, then open the app:

   ```sh
   npm run build
   npm start
   ```

3. For active development, close the app and run:

   ```sh
   npm run dev
   ```

   This starts the development interface and Electron app. Interface edits update through Vite. Restart this command after changing Electron main-process or preload code so those changes are rebuilt.

4. To try the task flow without an AI account, select **Demo mode** in **Settings → AI connection**, choose a temporary workspace folder, and save. Send a task and review its proposed file change. The demo is scripted and does not call a language model.

**API keys, paid subscriptions, and model downloads are not needed for the demo or unit tests.** Live provider tests are optional and use your own account. The browser fixture tests use a synthetic local site rather than a real shopping account.

## 4. Make a focused change

1. Keep each pull request about one problem. Read the surrounding code and follow its existing patterns so the change is easier to review.
2. For a bug fix or behavior change, add or adjust a meaningful test that covers the result. Documentation-only edits generally do not need new automated tests; check the steps and links you changed.
3. Keep approval checks, permission boundaries, and cancellation behavior intact. Skills and bot profiles are instructions, not a way to grant extra tool permissions. Describe any intentional changes to these behaviors in your pull request.
4. Never commit API keys, access tokens, passwords, `.env` files, browser profiles, cookies, personal task history, or screenshots containing private information. Use temporary workspaces and test data. Do not add generated installers, `node_modules`, or build output to a source change.

## 5. Check your work

1. Install the Chromium browser used by the browser tests:

   ```sh
   npx playwright-core install chromium
   ```

   On Linux, if the test browser reports missing system libraries, use `npx playwright-core install --with-deps chromium`. That command installs browser dependencies and may request administrator privileges through your system package manager.

2. Run the standard checks:

   ```sh
   npm run typecheck
   npm test
   npm run test:browser
   npm run build
   ```

   `typecheck` finds TypeScript errors. `test` runs the automated suite. `test:browser` requires a real installed test browser and exercises isolated browser fixtures; this avoids silently accepting a skipped browser test. `build` checks that the app can be compiled.

3. For interface or desktop-bridge changes, optionally run the desktop smoke checks after building:

   ```sh
   npm run smoke
   npm run test:capabilities
   ```

   These checks launch Electron and require a working graphical desktop session. They use temporary application data. The capabilities check also refreshes `docs/screenshots/workspace-dark.png` and `docs/screenshots/agents-skills.png`; inspect those changes and include them only when they are relevant to your pull request.

4. Manually try the behavior you changed. For interface changes, check light and dark themes, keyboard navigation, and a smaller window. In your pull request, state which operating system you tested and which checks you could not run. Passing on one system does not establish that the other systems work.

## 6. Commit and push to your fork

1. Inspect your changes before saving them in Git:

   ```sh
   git status
   git diff
   ```

   `status` lists changed files; `diff` shows their contents. Check that the list contains only your intended contribution and no private data.

2. Stage the specific files you changed. For example, if your contribution changes only the README:

   ```sh
   git add README.md
   git diff --cached
   git commit -m "Clarify workspace setup instructions"
   ```

   Replace `README.md` and the commit message with your actual files and change. `diff --cached` shows exactly what the commit will contain.

3. Push your branch to your fork:

   ```sh
   git push -u origin improve-workspace-help
   ```

   Use the branch name you created earlier. `origin` points to your fork, so this does not push directly to the main Orbit repository.

## 7. Open a pull request

1. Visit [Orbit pull requests](https://github.com/aaka3h/orbit-desktop/pulls) and select **New pull request → compare across forks**, or use GitHub's **Compare & pull request** button on your fork.
2. Set the **base repository** to `aaka3h/orbit-desktop` and **base branch** to `main`. Set the **head repository** to your fork and the **compare branch** to your contribution branch. This proposes your changes to the original project.
3. Explain the problem, what changes for the user, and how you tested it. Link the related issue. Include screenshots for visible changes, without personal information.
4. Submit the pull request. The **Contributor checks** workflow runs tests and builds on Linux, Windows, and macOS. For a first-time external contribution, GitHub may wait for a maintainer to approve the workflow run. A pending approval does not mean your code has failed.
5. Read the check results and respond to review comments. Further commits pushed to the same branch update the same pull request. Fork pull requests do not receive the repository's secrets; the contributor checks use synthetic test data, so you do not need to provide API credentials.
6. Maintainers decide whether and when to merge. Opening a pull request does not directly change `main` or publish a release; review keeps the project under maintainer control.

## 8. Follow the project license

1. Read the [MIT license](LICENSE). Contributions to Orbit are made under this project's MIT license.
2. Submit only work you have the right to contribute. Preserve required attribution and license notices for any third-party material you include.

For product behavior, platform limitations, and installation instructions, see the [README](README.md), [installation guide](INSTALL.md), and [agents and skills guide](docs/AGENTS-AND-SKILLS.md).
