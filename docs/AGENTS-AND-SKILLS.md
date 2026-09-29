# Use Orbit as an agent

## 1. Choose the AI that plans the work

1. Open **Settings → AI connection** and choose a supported cloud API, **ChatGPT subscription (Codex)**, or a local model. Cloud connections do not need Ollama or a local model download.
2. Complete the connection and choose a workspace folder. The AI plans actions; Orbit executes approved tools on your computer.
3. For ChatGPT sign-in, install the current official Codex CLI and use Orbit's sign-in button. This experimental bridge uses the official App Server dynamic-tool interface. Claude and Gemini integration uses API keys; opening their websites does not connect a subscription. Read [account support](cloud-accounts.md) for limits and verification status.

## 2. Open the separate browser

1. Install Google Chrome or Microsoft Edge normally on your computer. Orbit does not download a browser in the packaged app.
2. Open **Agents & skills → Browser**, enable browser access, choose Chrome or Edge, and save. Then open the Orbit browser.
3. Sign into shopping and other websites manually in that browser. Orbit uses its own profile below the app's data directory; it does not import your personal browser profile. Website sessions persist in that separate profile.
4. Keep this window visible. Orbit can navigate, read page text, click referenced controls, fill ordinary text fields, press supported keys and switch tabs. Every action asks for approval showing its target.
5. Passwords, one-time codes, payment fields, uploads and downloads need manual interaction. The model cannot ask this tool for cookies, arbitrary JavaScript or profile files. Reading a page sends its visible text to the selected model, so only open sites you intend the model to use.

## 3. Try a shopping task

1. Choose **Shopping assistant** in the composer. Give your country, budget and priorities, such as: “Compare three phones under ₹30,000 in India. I care about camera and battery. Include sources and wait for my choice.”
2. Approve the research actions. The model reads pages and reports product comparisons. Prices, availability, model quality and website compatibility affect results.
3. Choose a product and seller. Orbit can help with supported cart controls after approval.
4. Review checkout carefully. Detected purchase/checkout controls and form submissions require the purchase checkbox and **Confirm this purchase**. Orbit rechecks the target after approval and rejects stale controls. Classification uses page labels, URLs and form context; it cannot determine every site's hidden behavior. Always inspect the exact action and total. If the site cannot be handled reliably, finish checkout manually.
5. Click **Stop** to cancel a task. In-flight browser cancellation closes the owned browser; completed actions cannot be undone. No real purchase is made during Orbit's tests.

## 4. Make a skill or bot

1. Open **Agents & skills → Skills** and create a skill. Give it a name, a short description and instructions such as “Explain each step for a beginner.” Save it and enable it for tasks.
2. Open **Bots**, create a bot and choose its skills and tool groups. A bot is a saved assistant profile, not an unattended service or messaging account.
3. Select the bot in the composer. Its tool groups intersect the app's permissions: choosing Browser or Commands does not enable those permissions by itself. Stop an active task before editing settings or capabilities.
4. Built-in and plugin entries are read-only. Create your own entry to adapt them. Skills are guidance for the model, not extra execution permissions.

## 5. Install an instruction plugin

1. Download or create a JSON file matching [the example](../examples/productivity.orbit-plugin.json).
2. In **Plugins**, import the file and read every included skill, bot and requested tool group. Check the review box and install it. The reviewed contents are frozen for five minutes, so changing the file afterward does not change what gets installed.
3. Enable the installed plugin, then choose its bot or skills. New plugins start disabled. Removing or disabling a plugin makes its entries unavailable; edit any custom bots that depended on them.
4. Version 0.3 plugins contain **instructions and bot profiles only**. Executable plugins, third-party MCP servers, plugin marketplaces, Telegram/Discord bots and scheduled background tasks are not implemented.

## 6. Understand current limits

1. The browser adapter is tested against synthetic pages. CAPTCHA, site bot restrictions, complex widgets, embedded frames and some sign-in flows may need you to take over. WebSockets and service workers are blocked in the agent browser, which can affect sites.
2. Public URL and DNS checks, redirect checks and protocol restrictions reduce unintended network access. They are not an operating-system network sandbox, and do not provide DNS pinning across Chromium's own resolution or cover every browser subsystem.
3. Page text is untrusted input. The model is instructed to ignore page instructions that conflict with your task, but approvals and your review remain necessary.
4. The Codex tool bridge has protocol tests. A live signed-in ChatGPT task has not been validated in this build. Native Codex reads and separately configured integrations are not governed by Orbit bot tool lists; see the account guide.
5. Desktop mouse/keyboard control is separate, requires Python and OS permissions, and uses the focused application. Prefer browser tools for web tasks.
