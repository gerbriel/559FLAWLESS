# Calendar System - Quick Start Guide

## 🚀 Quick Start

### Accessing the Calendar
Navigate to: `/dashboard/calendar`

### View Modes

#### Day View
- Hourly breakdown (8 AM - 8 PM)
- Shows all appointments with time slots
- Click empty slots to add appointments
- Best for: Detailed daily scheduling

#### Week View (Default)
- 7-day grid layout
- Appointments shown as cards
- Quick overview of the week
- Best for: Weekly planning

#### Month View
- Full calendar month
- Appointment indicators per day
- Click any day to see details
- Best for: Long-term overview

### Filtering

1. Click **Filters** button
2. Select/deselect providers
3. Appointments update instantly
4. Click **All** to clear filters

### Appointment Actions

**View Details:**
- Click any appointment
- Modal shows full information
- Contact info is clickable

**Quick Actions:**
- Mark Complete
- Reschedule
- Add Note
- Cancel Appointment

**Close Modal:**
- Click Close button
- Press ESC key
- Click outside modal

## 🎨 Color Coding

Each provider has a consistent color:
- Provider 1: Rust/Orange
- Provider 2: Blue
- Provider 3: Rose Clay
- Provider 4: Sage Green
- Provider 5: Gold

## ⚙️ Features by Role

### Provider
- See only your appointments
- Cannot filter (already filtered)
- All view modes available
- Full appointment details

### Front Desk / Manager / Admin
- See all appointments
- Filter by any provider(s)
- All view modes available
- Full appointment details
- Quick-add appointments

## 📱 Responsive Design

### Mobile
- Single column layout
- Scrollable appointment list
- Touch-friendly buttons

### Tablet
- 2-column week view
- Larger touch targets
- Side-by-side navigation

### Desktop
- 7-column week view
- Full calendar grid
- Hover states active

## ⌨️ Keyboard Shortcuts

- **ESC**: Close modal
- **Tab**: Navigate controls
- **Enter**: Activate focused button

## 🔄 URL Synchronization

The calendar syncs with URL parameters:
- `?from=2026-08-01`: Start date
- `?view=day`: View mode
- Bookmark-friendly
- Back button works

## 📊 Data Display

### Appointment Card Shows:
- Time (in provider's timezone)
- Client name
- Service name
- Provider (color border)

### Modal Shows:
- Full datetime and duration
- Client contact information
- Provider details
- All services with prices
- Total and deposit
- Both client and staff notes
- Current status

## 🛠️ Technical Notes

### Performance
- Server-side data fetching
- View state persisted locally
- Instant filter application
- No unnecessary re-renders

### Security
- Row-level security enforced
- Providers see only their data
- No client-side role escalation
- Secure data transmission

### Timezone Handling
- All times in provider's timezone
- DST-safe conversions
- Accurate date boundaries
- No ambiguous times

## 🐛 Troubleshooting

**Appointments not showing?**
- Check date range (use Today button)
- Clear provider filters
- Verify appointment status (cancelled appointments hidden)

**Wrong timezone?**
- Times display in provider's configured timezone
- Update profile timezone if needed

**Modal not closing?**
- Try ESC key
- Try clicking outside modal
- Reload page if stuck

## 📈 Common Workflows

### Daily Check-in
1. Click **Today** button
2. Switch to **Day View**
3. Review hourly schedule
4. Click appointments as clients arrive

### Weekly Planning
1. Use **Week View** (default)
2. Navigate with Prev/Next
3. Click appointments to see details
4. Note gaps for scheduling

### Monthly Overview
1. Switch to **Month View**
2. Scroll through months
3. Identify busy/slow periods
4. Click days for details

### Provider Comparison
1. Open **Filters**
2. Select multiple providers
3. Compare schedules side-by-side
4. Identify booking patterns

## 💡 Pro Tips

1. **Save time**: Bookmark your preferred view
   - Example: `/dashboard/calendar?view=day`

2. **Quick navigation**: Use Today button frequently
   - Returns to current date instantly

3. **Color learning**: Provider colors are consistent
   - Learn colors for quick identification

4. **Modal actions**: Use keyboard shortcuts
   - ESC is faster than clicking Close

5. **URL sharing**: Copy URL to share specific dates
   - Team coordination made easy

## 🔗 Related Features

- **Appointments Page**: `/dashboard/appointments`
- **Client Details**: Click appointment → Client name
- **Provider Schedule**: `/dashboard/schedule`
- **Booking Page**: Click empty slot → Add appointment

## 📝 Feedback

Found an issue or have a suggestion?
- Check existing documentation
- Review role permissions
- Test with different views
- Verify timezone settings
