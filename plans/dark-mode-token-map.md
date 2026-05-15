# Dark Mode — Token Migration Reference

Canonical mapping for Phase 2 of `plans/dark-mode.md`: converting hardcoded
Tailwind color utilities (`text-gray-500`, `bg-red-50`, …) to the semantic
tokens defined in `web/src/css/App.css`. Every token below has a light value in
`:root` and a dark value in `.dark`, so using them makes a component
theme-aware automatically.

## Available semantic tokens

`background` `foreground` · `card` `card-foreground` · `popover`
`popover-foreground` · `primary` `primary-foreground` · `secondary`
`secondary-foreground` · `muted` `muted-foreground` · `accent`
`accent-foreground` · `destructive` `destructive-foreground` `destructive-muted`
· `success` `success-foreground` `success-muted` · `warning`
`warning-foreground` `warning-muted` · `info` `info-foreground` `info-muted` ·
`border` `input` `ring` · `bg-default`

Use them as normal Tailwind utilities: `bg-card`, `text-muted-foreground`,
`border-border`, `ring-ring`, `bg-destructive-muted`, `text-success`, etc.

## Mapping table

### Text
| Hardcoded | Token |
|---|---|
| `text-gray-900`, `text-gray-800`, `text-black` | `text-foreground` |
| `text-gray-700` | `text-foreground` (default) or `text-secondary-foreground` |
| `text-gray-600`, `text-gray-500`, `text-gray-400`, `text-gray-300` | `text-muted-foreground` |
| `text-red-500/600/700/800/900` | `text-destructive` |
| `text-green-500/600/700/800` | `text-success` |
| `text-blue-500/600/700` | `text-primary` (links, primary accents) |
| `text-amber-*`, `text-yellow-*` (600–900) | `text-warning-foreground` (text on a warning surface) or `text-warning` (standalone icon/accent) |
| `text-white` | **keep** when it sits on a colored surface (destructive/primary/colored badge); change to `text-foreground` only if it's on a neutral surface |

### Backgrounds
| Hardcoded | Token |
|---|---|
| `bg-white` | `bg-card` (panels, cards, inputs) — use `bg-background` only for a full-page surface |
| `bg-gray-50` | `bg-muted` |
| `bg-gray-100` | `bg-muted` for a static surface; `bg-accent` for a hover/selected/active state |
| `bg-gray-200` | `bg-accent` |
| `bg-red-50`, `bg-red-100` | `bg-destructive-muted` |
| `bg-green-50`, `bg-green-100` | `bg-success-muted` |
| `bg-blue-50`, `bg-blue-100` | `bg-info-muted` |
| `bg-amber-50/100`, `bg-yellow-50/100` | `bg-warning-muted` |
| `bg-black/50` and other translucent scrims | **keep** — deliberate overlay, works on both themes |

### Borders
| Hardcoded | Token |
|---|---|
| `border-gray-100`, `border-gray-200` | `border-border` |
| `border-gray-300` | `border-input` (form fields) or `border-border` |
| `border-red-200/300` | `border-destructive/30` |
| `border-green-200/300` | `border-success/30` |
| `border-blue-200/300/500` | `border-info/40` (or `border-primary` for a primary-accent border) |
| `border-amber/yellow-200/300` | `border-warning/30` |

### Rings / outlines / focus
| Hardcoded | Token |
|---|---|
| `ring-blue-400/500`, `focus-visible:ring-blue-*` | `ring-ring` |
| `ring-red-*` | `ring-destructive` |
| `outline-*` colored | matching token |

### Hover / state variants
Apply the same mapping under the variant prefix:
- `hover:bg-gray-50`, `hover:bg-gray-100` → `hover:bg-accent`
- `hover:text-gray-700/900` → `hover:text-foreground`
- `hover:bg-red-100` → `hover:bg-destructive-muted`
- `data-[state=active]:bg-white` → `data-[state=active]:bg-background`

## Rules

1. **Judgement on greys.** `bg-gray-100` is sometimes a surface, sometimes a
   hover state, sometimes disabled. Read the element before replacing — don't
   blind-swap. When genuinely ambiguous: static surface → `bg-muted`,
   interactive state → `bg-accent`.
2. **Keep translucent scrims** (`bg-black/50`, `bg-white/10` glass effects) —
   they read correctly on both themes.
3. **Keep `text-white` / `text-black` on colored surfaces.** White text on a
   `bg-destructive` button stays `text-white`.
4. **Preserve opacity modifiers** where they make sense: `text-gray-500/70`
   → `text-muted-foreground/70`.
5. **Don't touch** non-color utilities, arbitrary `shadow-[...]` glow values,
   `bg-transparent`, `border-transparent`, or gradient geometry. Arbitrary
   colored shadows can be left as-is for now.
6. **Darker colored shades collapse to the base token.** `text-red-800` and
   `text-red-600` both become `text-destructive`; the token already has
   distinct light/dark values.
7. **Update component tests.** If a test asserts on a color class you changed
   (e.g. `toHaveClass('text-red-600')`), update the assertion to the new token.
8. **No new comments** explaining the swap — keep diffs clean.

## Verification per batch

After editing a batch of files:
- `cd web && bunx tsc --noEmit -p tsconfig.app.json` — must stay clean.
- `cd web && bunx vitest run <changed test files>` — run tests for any
  component you touched that has a `__tests__` dir or `.test.tsx` sibling.
- `bunx oxlint <files>` — no new warnings.
