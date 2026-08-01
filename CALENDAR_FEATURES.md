# Enhanced Calendar System

## Overview
The 559 Flawless calendar view has been upgraded with multiple view modes, filtering capabilities, and an interactive appointment modal.

## Features Implemented

### 1. Multiple View Modes
- **Day View**: Hourly breakdown (8 AM - 8 PM) with all appointments for a single day
- **Week View**: 7-day grid showing appointments by day
- **Month View**: Full calendar month with appointment indicators
- View preference is persisted in localStorage

### 2. Provider Filtering
- Filter appointments by one or more providers
- Color-coded appointments (each provider gets a consistent color)
- "All" and "Clear" filter controls
- Visual indicators showing active filters

### 3. Interactive Calendar
- **Click on appointment**: Opens detailed modal
- **Click on day (month view)**: Switches to day view for that date
- **Click on empty slot (day view)**: Quick-add appointment (navigates to booking)
- Navigation controls: Previous/Today/Next buttons

### 4. Appointment Details Modal
Shows comprehensive appointment information:
- Status badge with appropriate color
- Date, time, and duration
- Client information (name, email, phone - all clickable)
- Provider details
- Service list with prices
- Financial summary (total, deposit)
- Client notes and staff notes

**Quick Actions in Modal:**
- Mark Complete
- Reschedule
- Add Note
- Cancel Appointment
- (Actions adapt to appointment status)

### 5. Visual Design
- Uses existing design tokens from `globals.css`
- Provider colors from the validated viz-root palette
- Status-specific badges with proper contrast
- Responsive layout with mobile-first approach
- Smooth transitions and hover states

## Files Structure

```
src/
  app/dashboard/calendar/
    page.tsx                          # Server component - fetches data
  components/shared/
    CalendarClient.tsx                # Client wrapper - manages state
    CalendarView.tsx                  # View components (Day, Week, Month)
    AppointmentModal.tsx              # Appointment details popup
```

## Usage Patterns

### For Providers
- See only their own appointments
- Cannot filter by other providers
- All navigation and modal features available

### For Front Desk / Managers / Admins
- See all appointments
- Can filter by specific providers
- Full access to all calendar features

## Data Flow

1. **Server Page** (`page.tsx`):
   - Fetches appointments based on date range and view
   - Loads all active providers for filtering
   - Passes data to client component

2. **Client Component** (`CalendarClient.tsx`):
   - Manages view state (day/week/month)
   - Handles date navigation
   - Controls filter state
   - Opens/closes appointment modal
   - Syncs state with URL params

3. **View Component** (`CalendarView.tsx`):
   - Renders appropriate view based on mode
   - Applies provider filters
   - Generates time slots and calendar grids
   - Handles click events

## Query Optimization

The calendar intelligently fetches data based on the view:
- **Day view**: Fetches 1 day
- **Week view**: Fetches 7 days
- **Month view**: Fetches ~35-42 days (full month with padding)

Date ranges are calculated in the provider's timezone to ensure accuracy across DST boundaries.

## Key Implementation Details

### Provider Colors
Uses colors from the chart token system (`--series-1`, `--series-2`, etc.) with proper contrast validation for both light and dark modes.

### Timezone Handling
All date/time operations go through `src/lib/time.ts`:
- `dateKeyInTimeZone()` - Convert instant to YYYY-MM-DD in zone
- `zonedTimeToUtc()` - Convert wall clock to absolute instant
- `formatTimeInTimeZone()` - Display time in provider's zone
- `addDaysToDateKey()` - Calendar arithmetic

### RLS Compliance
Respects row-level security:
- Providers automatically filtered to their appointments
- Front desk+ can view all appointments
- No client-side role escalation possible

## Extension Points

### Adding More Filters
To add client filtering or service filtering:
1. Add state in `CalendarClient.tsx`
2. Add filter UI in `CalendarView.tsx`
3. Apply filter in the `filteredAppointments` useMemo

### Drag-to-Reschedule
The architecture supports drag-to-reschedule. To implement:
1. Add drag handlers to appointment elements
2. Calculate new slot from drop position
3. Call reschedule API with new datetime
4. Refresh data on success

### Quick Add Appointment
Currently navigates to booking page. To add inline:
1. Create a quick-add modal component
2. Handle submission with booking API
3. Refresh calendar data on success

## Performance Notes

- Appointment data is fetched server-side (no loading flicker)
- View state persists in localStorage (no flickering on refresh)
- Provider filtering happens client-side (instant response)
- Modal uses React portals (proper stacking context)

## Accessibility

- Keyboard navigation supported (Tab, Enter, Escape)
- Focus management in modal (trapped when open)
- ARIA labels on interactive elements
- High contrast status indicators
- Touch-friendly click targets (min 44x44px)

## Browser Support

- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires JavaScript (client components)
- Responsive breakpoints:
  - Mobile: Single column
  - Tablet: 2 columns (week view)
  - Desktop: 7 columns (week view)
