# Preset Manager

A SillyTavern extension to manage your **Chat Completion** presets from one clean,
mobile-friendly panel — multi-select, bulk-delete, and edit prompts and parameters
in cleanly separated tabs.

## Features

- **Preset list** — every Chat Completion preset shown as a card, with search and sort.
- **Multi-select + bulk delete** — tick several presets and delete them all with a
  single confirmation (no more deleting one-by-one).
- **Per-card actions** — edit, rename, duplicate, delete.
- **Editor with two tabs** (Prompts always first):
  - **Prompts** — expand any prompt to edit its name, role and content. Each prompt has:
    - a **fullscreen** content editor (like the CSS / persona editors in SillyTavern),
    - **duplicate** and **delete** buttons,
    - a **detach** (forbid character overrides) toggle.
  - **Parameters** — grouped into round, collapsible sections (Sampling, Penalties,
    Context & Length, Reasoning & Output, Utility Prompts, plus an Other/advanced section).
    Long text parameters also get a fullscreen editor.
- **Turn the manager on/off** from the extension settings.

## Opening the manager

- Open the wand (extensions) menu and click **Preset Manager**, or
- Extensions panel → **Preset Manager** → *Open Preset Manager*.

## Installation

Extensions → Install extension, then paste the Git URL:

```
https://github.com/Nufahi/ST-PresetManager
```

> Works with the Chat Completion API. Switch your API to Chat Completion to see your presets.
