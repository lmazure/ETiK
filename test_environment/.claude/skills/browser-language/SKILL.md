---
name: browser-language
description: Switch the browser preferred language (locale) for playwright-cli sessions, so that web applications that respect Accept-Language serve their UI in the chosen language.
allowed-tools: Read Edit Bash(playwright-cli:*)
---

# Switching the Browser Preferred Language

## How it works

playwright-cli reads its browser context settings from `.playwright/cli.config.json` at the project root. Setting `contextOptions.locale` and `contextOptions.extraHTTPHeaders["Accept-Language"]` in that file makes every new browser session advertise the chosen language to the server.

- `locale` sets `navigator.language` / `navigator.languages` inside the page.
- `Accept-Language` is the HTTP request header that server-side applications (Java, PHP, Rails, …) use to choose the UI language.

Both must be set together; either one alone may not be sufficient.

## Step-by-step: switch to French

### 1. Edit `.playwright/cli.config.json`

Read the current file first, then add `contextOptions`:

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "channel": "chromium"
    },
    "contextOptions": {
      "locale": "fr-FR",
      "extraHTTPHeaders": {
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.1"
      }
    }
  }
}
```

### 2. Close any open browser and reopen

The context options are applied only when a new browser session is created.

```bash
playwright-cli close
playwright-cli open https://example.com
```

### 3. Verify

```bash
playwright-cli eval "navigator.language + ' / ' + navigator.languages.join(', ')"
# Expected: "fr-FR / fr-FR"
```

If the target application is now in French, the switch is complete.

## Revert to default (English)

Remove `contextOptions` from `.playwright/cli.config.json`, then close and reopen:

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "channel": "chromium"
    }
  }
}
```

```bash
playwright-cli close
playwright-cli open https://example.com
```

## Other languages

Replace the BCP 47 locale tag and the `Accept-Language` value:

| Language | `locale` | `Accept-Language` |
|---|---|---|
| English (US) | `en-US` | `en-US,en;q=0.9` |
| French | `fr-FR` | `fr-FR,fr;q=0.9,en;q=0.1` |
| German | `de-DE` | `de-DE,de;q=0.9,en;q=0.1` |
| Spanish | `es-ES` | `es-ES,es;q=0.9,en;q=0.1` |
| Japanese | `ja-JP` | `ja-JP,ja;q=0.9,en;q=0.1` |

## Notes

- The `contextOptions` block is **not** supported when `playwright-cli open` is invoked with `--browser=chrome` (Chrome channel). Use `"channel": "chromium"` in the config instead of the `--browser` flag.
- The setting applies to all sessions (named and default) that load this config file.
- Some applications store the language preference server-side (in the session or user profile) and ignore `Accept-Language` once a session is established. In that case, the language switch only takes effect when starting a completely fresh session (no existing cookies).
