# Stone Memory Theme Studio

The theme studio is a removable frontend module. Stone Memory integrates it through one line in `src/web/public/index.html`:

```html
<script src="/theme-studio/bootstrap.js" defer></script>
```

`bootstrap.js` loads the module-owned runtime styles, applies the active browser theme, and injects the developer-mode entry. The standalone editor, theme contract, runtime styles, and adapter styles all live in this directory.

## Remove the module

1. Remove the `bootstrap.js` script tag from `src/web/public/index.html`.
2. Delete `src/web/public/theme-studio/`.

Stone Memory business data, APIs, and database files are not used by this module. Browser theme preferences may remain in local storage under `stone-memory-ui-theme-v1` and `stone-memory-ui-themes-v1`, but they are inert after the bootstrap script is removed.
