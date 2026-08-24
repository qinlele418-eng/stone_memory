# Stone Memory Theme Studio

The theme studio is a removable frontend module. Stone Memory integrates it through one line in `src/web/public/index.html`:

```html
<script src="/theme-studio/bootstrap.js" defer></script>
```

`bootstrap.js` loads the module-owned runtime styles, applies the active browser theme, and injects the developer-mode entry. The standalone editor, theme contract, runtime styles, and adapter styles all live in this directory.

The visual contract is native to Stone Memory: semantic properties use the `--stone-theme-*` prefix, and the built-in choices are Stone Memory Original and 松烟青. User-created themes keep the same structured JSON fields and do not depend on a third-party visual preset.

`contract.json` is the single source for default tokens and the editable token inventory. Contract version 3 uses the current compact export shape (`$schema`, `version`, `name`, `assets`, and `tokens`) and removes the retired description field. Existing version 1 and version 2 themes are merged with the version 3 defaults and saved back in the new shape; the storage key intentionally remains unchanged so existing browser themes are discovered automatically.

## Remove the module

1. Remove the `bootstrap.js` script tag from `src/web/public/index.html`.
2. Delete `src/web/public/theme-studio/`.

Stone Memory business data, APIs, and database files are not used by this module. Browser theme preferences may remain in local storage under `stone-memory-ui-theme-v1` and `stone-memory-ui-themes-v1`, but they are inert after the bootstrap script is removed.
