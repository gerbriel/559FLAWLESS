# Calendar Visual Guide

## Interface Layout

### Header Section
```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  Calendar                                                           │
│                                                                     │
│  [Day] [Week] [Month]  [Filters ▼] [◄ Prev] [Today] [Next ►]    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Elements:**
- **Title**: "Calendar" in display font (Cormorant)
- **View Toggles**: Three buttons (active one has accent background)
- **Filters Button**: Opens provider filter panel
- **Navigation**: Prev/Today/Next buttons adapt to current view

---

## Week View (Default)

```
┌────────┬────────┬────────┬────────┬────────┬────────┬────────┐
│ SUN  1 │ MON  2 │ TUE  3 │ WED  4 │ THU  5 │ FRI  6 │ SAT  7 │
├────────┼────────┼────────┼────────┼────────┼────────┼────────┤
│        │ 9:00AM │        │ 10:00AM│ 9:00AM │        │        │
│   —    │ Sarah  │   —    │ Maria  │ David  │   —    │   —    │
│        │ Facial │        │ Waxing │ Facial │        │        │
│        │ ┃      │        │ ┃      │ ┃      │        │        │
│        │ ┃      │        │ ┃      │ ┃      │        │        │
│        │        │        │        │        │        │        │
│        │ 2:00PM │        │ 3:00PM │ 11:30AM│        │        │
│        │ Emily  │        │ Lisa   │ Anna   │        │        │
│        │ Nails  │        │ Facial │ Waxing │        │        │
│        │ ┃      │        │ ┃      │ ┃      │        │        │
└────────┴────────┴────────┴────────┴────────┴────────┴────────┘
```

**Features:**
- 7 columns (one per day)
- Day name + date at top
- Today highlighted with accent color
- Each appointment shows:
  - Time (12-hour format)
  - Client name
  - Service name
  - Color-coded left border (provider)
- Empty slots show "—"

**Colors (left border):**
```
┃ Rust/Orange  → Provider 1
┃ Blue         → Provider 2
┃ Rose Clay    → Provider 3
┃ Sage Green   → Provider 4
┃ Gold         → Provider 5
```

---

## Day View

```
┌─────────────────────────────────────────────────────────────────┐
│ Monday, August 4, 2026                           [Today Badge]  │
└─────────────────────────────────────────────────────────────────┘

 08:00  │  —
────────┼──────────────────────────────────────────────────────────
 09:00  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        │  ┃ Sarah Thompson                          $125.00 ┃
        │  ┃ Deep Cleansing Facial                          ┃
        │  ┃ 9:00 AM - 10:30 AM                             ┃
        │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
────────┼──────────────────────────────────────────────────────────
 10:00  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        │  ┃ Maria Garcia                            $85.00  ┃
        │  ┃ Brazilian Wax                                   ┃
        │  ┃ 10:00 AM - 10:45 AM                            ┃
        │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
────────┼──────────────────────────────────────────────────────────
 11:00  │  —
────────┼──────────────────────────────────────────────────────────
 12:00  │  —
────────┼──────────────────────────────────────────────────────────
 01:00  │  —
────────┼──────────────────────────────────────────────────────────
 02:00  │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
        │  ┃ Emily Chen                              $75.00  ┃
        │  ┃ Gel Manicure                                    ┃
        │  ┃ 2:00 PM - 3:00 PM                              ┃
        │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
────────┼──────────────────────────────────────────────────────────
```

**Features:**
- Hourly time slots (8 AM - 8 PM)
- Full appointment cards with:
  - Client name
  - Service
  - Time range
  - Price (right-aligned)
- Color-coded left border
- Empty slots clickable for quick-add
- Expanded view of each appointment

---

## Month View

```
┌────────────────────────────────────────────────────────────────────┐
│                        August 2026                                 │
└────────────────────────────────────────────────────────────────────┘

  Sun     Mon     Tue     Wed     Thu     Fri     Sat
┌───────┬───────┬───────┬───────┬───────┬───────┬───────┐
│       │       │       │       │   1   │   2   │   3   │
│       │       │       │       │  ━    │  ━━   │       │
│       │       │       │       │  9:00 │  9:00 │       │
│       │       │       │       │       │  2:00 │       │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤
│   4   │   5   │   6   │   7   │   8   │   9   │  10   │
│  ━━   │       │  ━    │  ━━━  │       │  ━━   │       │
│  9:00 │       │  3:00 │  9:00 │       │  9:00 │       │
│  2:00 │       │       │  1:00 │       │  4:00 │       │
│       │       │       │  5:00 │       │       │       │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤
│  11   │  12   │  13   │  14   │  15   │  16   │  17   │
│  ━    │  ━━━  │       │  ━━   │  ━    │       │  ━━━  │
│ 10:00 │  9:00 │       │  9:00 │  3:00 │       │  9:00 │
│       │  1:00 │       │  2:00 │       │       │  1:00 │
│       │  4:00 │       │       │       │       │  4:00 │
├───────┼───────┼───────┼───────┼───────┼───────┼───────┤
│  18   │  19   │  20   │  21   │  22   │  23   │  24   │
│       │  ━━   │  ━    │       │  ━━━  │  ━    │       │
│       │  9:00 │  2:00 │       │  9:00 │  5:00 │       │
│       │  3:00 │       │       │  1:00 │       │       │
│       │       │       │       │  3:00 │       │       │
└───────┴───────┴───────┴───────┴───────┴───────┴───────┘
```

**Features:**
- Standard calendar grid (7 columns × ~5 rows)
- Date number in each cell
- First 3 appointments shown as colored bars with time
- "+X more" indicator if >3 appointments
- Today highlighted with circular accent background
- Click day → switch to day view
- Click appointment bar → open modal

**Legend:**
```
━  Short appointment bar (color-coded by provider)
━━ Longer appointment bar
━━━ Full day or multiple appointments
```

---

## Filter Panel

```
┌─────────────────────────────────────────────────────────────────┐
│ FILTER BY PROVIDER                                     [All]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [✓ Sarah Smith]  [✓ Maria Rodriguez]  [✓ David Chen]         │
│                                                                 │
│  [✓ Emily Taylor]  [ Ana Santos ]                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**States:**
- **Selected (✓)**: Accent background, white text
- **Unselected**: Border only, muted text
- **All button**: Clears all filters / selects all

---

## Appointment Modal

```
┌─────────────────────────────────────────────────────────────────┐
│  Appointment Details                         ID: a3f5d821    [×]│
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [CONFIRMED]  ← Status badge (blue)                            │
│                                                                 │
│  📅  Date & Time                                               │
│      Mon, Aug 4 · 9:00 AM                                      │
│                                                                 │
│  🕐  Duration                                                  │
│      9:00 AM - 10:30 AM                                        │
│                                                                 │
│  ────────────────────────────────────────────────────────────  │
│                                                                 │
│  👤  Client                                                    │
│      Sarah Thompson                                            │
│                                                                 │
│  📧  Email                                                     │
│      sarah.t@example.com  ← clickable                         │
│                                                                 │
│  📞  Phone                                                     │
│      (559) 555-0123  ← clickable                              │
│                                                                 │
│  ────────────────────────────────────────────────────────────  │
│                                                                 │
│  👤  Provider                                                  │
│      Maria Rodriguez                                           │
│                                                                 │
│  ────────────────────────────────────────────────────────────  │
│                                                                 │
│  Services                                                       │
│  • Deep Cleansing Facial                          $125.00     │
│                                                                 │
│  ────────────────────────────────────────────────────────────  │
│                                                                 │
│  💵  Total                                        $125.00      │
│      Deposit                                       $25.00      │
│                                                                 │
│  ────────────────────────────────────────────────────────────  │
│                                                                 │
│  📝  Client Notes                                              │
│      First time client, requested gentle products             │
│                                                                 │
│  📝  Staff Notes                                               │
│      Patch test completed on 7/28. No reactions.              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Mark Complete]  [Reschedule]  [Add Note]  [Cancel]  [Close] │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Full-screen overlay with centered modal
- Click outside or press ESC to close
- Scrollable content area
- Action buttons at bottom
- Icons for visual scanning
- Clickable contact information
- Color-coded status badge
- Financial summary
- Both client and staff notes

---

## Summary Footer

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  12 appointments   •   $1,450.00 total   •   2 providers       │
│                                                  filtered       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Shows:**
- Appointment count (filtered)
- Total revenue (filtered)
- Filter status (if active)

---

## Status Badge Colors

```
[PENDING]      Yellow background, dark yellow text
[CONFIRMED]    Blue background, dark blue text
[CHECKED IN]   Purple background, dark purple text
[COMPLETED]    Green background, dark green text
[CANCELLED]    Red background, dark red text
[NO SHOW]      Gray background, dark gray text
```

All badges use:
- Uppercase text
- Wide letter spacing
- Small font size
- Rounded corners (2px)
- Proper contrast for accessibility

---

## Responsive Behavior

### Desktop (1440px+)
```
┌──────────────────────────────────────────────────────────────┐
│ Week View: 7 columns side by side                           │
│ Month View: Full grid                                       │
│ Day View: Wide appointment cards                            │
└──────────────────────────────────────────────────────────────┘
```

### Tablet (768px - 1439px)
```
┌────────────────────────────────┐
│ Week View: 2 columns           │
│ Month View: Full grid          │
│ Day View: Full width cards     │
└────────────────────────────────┘
```

### Mobile (< 768px)
```
┌──────────────────┐
│ Week View: Stack │
│ Month View: Grid │
│ Day View: Stack  │
│                  │
│ Buttons wrap     │
│ Modal full width │
└──────────────────┘
```

---

## Dark Mode

All elements adapt to dark mode:
```
Light Mode                    Dark Mode
───────────                   ─────────
Background: Porcelain (#faf7f4) → Dark (#171110)
Surface: White                → Surface (#201917)
Text: Espresso                → Light (#f2ebe6)
Border: Line (#e0d5cc)        → Dark Border (#332823)
Accent: Clay (#b48a78)        → Light Clay (#c79c89)
```

Provider colors remain consistent (validated for both modes).

---

## Interaction States

### Hover
- **Appointment cards**: Shadow increases
- **Buttons**: Border color changes to accent
- **Empty slots**: Text color changes to accent
- **Modal backdrop**: Slight darkening

### Active/Selected
- **View buttons**: Accent background
- **Provider chips**: Accent background with white text
- **Today**: Circular accent background

### Focus (Keyboard)
- All interactive elements: 2px accent outline with 2px offset
- Modal: Focus trapped within
- Tab order: logical (top to bottom, left to right)

---

## Loading States

While data loads:
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    Loading calendar...                      │
│                          ⏳                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Note**: With server-side rendering, loading states are rare.

---

## Error States

If data fails to load:
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ⚠️ Unable to load appointments                            │
│                                                             │
│  [Retry]                                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Accessibility Features

### Keyboard Navigation
- **Tab**: Move between interactive elements
- **Enter/Space**: Activate buttons, open appointments
- **Escape**: Close modal, close filter panel
- **Arrow keys**: (Future) Navigate between dates

### Screen Readers
- Semantic HTML (`<button>`, `<nav>`, `<article>`)
- ARIA labels on icon-only buttons
- ARIA live regions for dynamic updates
- Proper heading hierarchy (h1 → h2 → h3)

### Visual
- Minimum contrast 4.5:1 (WCAG AA)
- Focus indicators always visible
- No color-only indicators (text + color)
- Sufficient touch target size (44×44px minimum)

---

This visual guide provides a clear reference for how the calendar interface appears and behaves. All elements follow the 559 Flawless design system for consistency.
