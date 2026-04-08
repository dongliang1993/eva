# Eva Design System

Based on CodePilot's design language, adapted for Eva.

All colors are CSS custom properties defined in `src/styles/index.css` via `@theme`.
Components use Tailwind semantic classes (`bg-background`, `text-foreground`, `border-border`).
To add a new theme, override the `@theme` block or add a `[data-theme="xxx"]` selector.

## Layout

```
┌─────────────────────────────────────────────────────┐
│                    TopBar (48px)                     │
│  [Logo]  [Session Title]              [New Chat]    │
├────────────┬────────────────────────────────────────┤
│            │                                        │
│  Sidebar   │          Chat Area                     │
│  (240px)   │                                        │
│            │   ┌────────────────────────────┐       │
│  Sessions  │   │    Message List (scroll)   │       │
│  List      │   │                            │       │
│            │   │  [user bubble - right]     │       │
│            │   │  [assistant msg - left]    │       │
│            │   │                            │       │
│            │   └────────────────────────────┘       │
│            │                                        │
│            │   ┌────────────────────────────┐       │
│            │   │    Input Area              │       │
│            │   │  [textarea]        [send]  │       │
│            │   │  [+ tools]  [model badge]  │       │
│            │   └────────────────────────────┘       │
│            │                                        │
├────────────┴────────────────────────────────────────┤
│              Bottom Bar (optional)                   │
│  [</> Code] [Plan] [Agent] [Permissions]            │
└─────────────────────────────────────────────────────┘
```

### Dimensions
- Sidebar width: `240px` (collapsible)
- TopBar height: `48px`
- Input area: fixed at bottom
- Chat area: `max-w-3xl` centered, flex-1 scrollable
- Message max-width: `80%` of chat area

## Color System

Uses CSS custom properties with OKLCH color space. Dark mode default.

### Core Tokens (Dark Mode)

```css
:root {
  /* Base */
  --background: #0f0f1a;        /* oklch(0.147 0.004 49.25) */
  --foreground: #f5f5f0;        /* oklch(0.985 0.001 106.423) */

  /* Surfaces */
  --card: #1e1e2e;              /* oklch(0.216 0.006 56.043) */
  --popover: #1e1e2e;
  --sidebar: #1e1e2e;

  /* Primary (Purple accent) */
  --primary: #7c6aef;           /* oklch(0.623 0.214 259.815) */
  --primary-foreground: #f5f5f0;

  /* Secondary */
  --secondary: #2a2a3a;         /* oklch(0.268 0.007 34.298) */
  --secondary-foreground: #f5f5f0;

  /* Muted */
  --muted: #2a2a3a;
  --muted-foreground: #8b8b9e;

  /* Borders */
  --border: rgba(255, 255, 255, 0.10);
  --input: rgba(255, 255, 255, 0.15);
  --ring: #7c6aef;              /* Same as primary */

  /* Semantic */
  --destructive: #e55a5a;
  --success: #3dab6f;
  --warning: #d4942a;

  /* User bubble */
  --user-bubble: #e8e8e0;       /* Light background */
  --user-bubble-foreground: #1a1a1a;

  /* Terminal/Code */
  --terminal-bg: #0a0a14;
  --terminal-fg: #d4d4d8;
}
```

### Usage Mapping

| Element | Background | Text | Border |
|---------|-----------|------|--------|
| Page | `--background` | `--foreground` | - |
| Sidebar | `--sidebar` | `--foreground` | `--border` right |
| TopBar | `--card` | `--foreground` | `--border` bottom |
| Card/Panel | `--card` | `--foreground` | `--border` |
| User bubble | `--user-bubble` | `--user-bubble-fg` | none |
| Assistant msg | transparent | `--foreground` | none |
| Input | `--background` | `--foreground` | `--input` |
| Button primary | `--primary` | `--primary-fg` | none |
| Button ghost | transparent | `--muted-fg` | none, hover `--secondary` |
| Code block | `--terminal-bg` | `--terminal-fg` | `--border` |
| Tool call block | `--terminal-bg` | `--foreground` | `--border` |

## Typography

| Element | Font | Size | Weight |
|---------|------|------|--------|
| Body | system-ui / Geist Sans | 14px (`text-sm`) | 400 |
| Heading (dialog) | system-ui | 18px (`text-lg`) | 600 |
| Session title | system-ui | 14px | 500 |
| Sidebar item | system-ui | 14px | 400 |
| Badge/label | system-ui | 12px (`text-xs`) | 500 |
| Code | Geist Mono / monospace | 13px | 400 |
| Input placeholder | system-ui | 14px | 400, `--muted-fg` |

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 8px | Buttons, inputs, badges |
| `--radius-md` | 10px | Cards, panels |
| `--radius-lg` | 12px | Dialogs, large containers |
| `--radius-xl` | 16px | User bubble, main cards |
| `--radius-2xl` | 20px | Input area container |

## Shadows

| Name | Value | Usage |
|------|-------|-------|
| `shadow-xs` | subtle | Inputs, buttons |
| `shadow-sm` | small | Cards, elevated surfaces |
| `shadow-lg` | large | Dialogs, modals |

## Spacing

| Element | Padding | Gap |
|---------|---------|-----|
| Sidebar items | `px-3 py-2` | `gap-1` |
| TopBar | `px-4 py-3` | `gap-3` |
| Chat messages | `px-4 py-6` | `gap-4` (between messages) |
| Message bubble | `px-4 py-3` | - |
| Input area | `px-4 py-3` | `gap-2` |
| Card | `px-6 py-6` | `gap-6` |
| Button default | `px-4 py-2` | `gap-2` |
| Button sm | `px-3 h-8` | `gap-1.5` |

## Scrollbar

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(140, 140, 160, 0.3);
  border-radius: 3px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(140, 140, 160, 0.5);
}
```

## Component Patterns

### Input Area (CodePilot style)
- Rounded container (`rounded-2xl`) with `--border`
- Textarea grows with content, no resize handle
- Bottom row: icon buttons (attach, commands, terminal) + model selector + send button
- Send button: circular, `--primary` bg, arrow icon

### User Message Bubble
- Right-aligned
- `--user-bubble` background (light in dark mode = inverted)
- `rounded-2xl` with slightly flat bottom-right
- No avatar

### Assistant Message
- Left-aligned, no bubble background
- Full-width markdown rendering
- Tool calls shown as collapsible blocks above text
- Code blocks with `--terminal-bg`, copy button on hover

### Sidebar
- Fixed width `240px`, `--sidebar` background
- "New Chat" button at top
- Session list with active highlight (`--secondary`)
- Time labels in `--muted-fg`
- Collapsible on mobile

### Radix UI Components to Use
- `@radix-ui/react-scroll-area` — custom scrollbar for sidebar + chat
- `@radix-ui/react-collapsible` — tool call blocks
- `@radix-ui/react-dialog` — settings/modals (future)
- `@radix-ui/react-tooltip` — button tooltips
- `@radix-ui/react-separator` — visual dividers
