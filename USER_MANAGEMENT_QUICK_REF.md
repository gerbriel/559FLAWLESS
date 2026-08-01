# User Management - Quick Reference

## Navigation Structure

```
Dashboard
├── Settings (Admin only)
│   ├── Booking Policy
│   ├── Staff List
│   │   └── [Button: Manage all users] → /dashboard/settings/users
│   └── Upcoming Closures
│
├── Marketing (Manager+)
│   ├── Newsletter Stats (clickable) → /dashboard/marketing/newsletter
│   ├── Reviews Awaiting
│   └── Announcements
│
├── /dashboard/settings/users (NEW - Admin only)
│   ├── Tabs: All Users | Staff | Clients
│   ├── Filters: Search, Role, Status
│   ├── User Table
│   └── [Click any row] → User Edit Modal
│
└── /dashboard/marketing/newsletter (NEW - Manager+)
    ├── Stats: Active | Total | Unsubscribe Rate
    ├── Filters: Search, Status, Type
    ├── Subscriber Table
    └── Actions: Export CSV, Add Subscriber, Unsubscribe
```

## Database Schema (Migration 015)

### New Tables
- `user_activity_log` - Audit trail for all user actions
- Enhanced `newsletter_subscribers` - Added consent tracking (IP, user agent, preferences)
- Enhanced `profiles` - Added `marketing_consent_at` timestamp

### New Functions
- `log_user_activity()` - Log actions to activity table
- `prevent_last_admin_removal()` - Safety trigger
- `log_profile_role_change()` - Auto-log trigger

### New View
- `user_management_list` - Aggregated user stats for admin UI

## API Endpoints

```
POST /api/admin/users/update
  └── Update user profile, role, or suspension status

POST /api/admin/users/reset-password
  └── Send password reset email
```

## Components

```
UserManagementTable.tsx
├── Tabs (All | Staff | Clients)
├── Search & Filters
├── User Table
└── Opens → UserEditForm.tsx
           ├── Basic Info
           ├── Role Selector
           ├── Suspension Toggle
           ├── Permission Matrix (read-only)
           ├── Activity Log (expandable)
           └── Actions: Save, Reset Password

NewsletterTable.tsx
├── Search & Filters
├── Subscriber Table
├── Export to CSV
└── Add Subscriber Modal
```

## Permission Matrix

| Role | Permissions |
|------|-------------|
| **Client** | Book, buy, view own records, sign forms, message |
| **Provider** | All client + manage calendar, treat clients, write notes, propose inventory |
| **Front Desk** | All client + book for others, view all clients, handle messages, process orders |
| **Manager** | All front desk + approve inventory, view analytics, manage marketing |
| **Admin** | All manager + manage users, change pricing, edit policies, edit settings |

## Security Features

✅ **Last Admin Protection** - Cannot remove or suspend last admin  
✅ **Activity Logging** - All role changes and suspensions logged  
✅ **RLS Enforcement** - All operations respect row-level security  
✅ **Server-Side Validation** - Admin role checked before privileged operations  
✅ **Database Triggers** - Non-admins cannot escalate their own role  

## Quick Start

### 1. Run Migration
```sql
-- Run: supabase/migrations/015_user_management.sql
```

### 2. Access User Management
```
Admin → Settings → Manage all users
```

### 3. Access Newsletter Management
```
Manager → Marketing → Newsletter Stats (click)
```

## Testing Checklist

- [ ] Admin can access `/dashboard/settings/users`
- [ ] Non-admin is redirected from `/dashboard/settings/users`
- [ ] Manager can access `/dashboard/marketing/newsletter`
- [ ] User edit form loads correctly
- [ ] Role changes are logged
- [ ] Cannot demote/suspend last admin
- [ ] Password reset emails send
- [ ] Activity log displays
- [ ] Newsletter filters work
- [ ] CSV export downloads
- [ ] Manual subscriber addition works

## Common Tasks

### Change a User's Role
1. Settings → Manage all users
2. Find user, click "Edit"
3. Select new role from dropdown
4. Review permission matrix
5. Click "Save changes"
6. Action is logged automatically

### Send Password Reset
1. Edit user (see above)
2. Click "Send password reset"
3. User receives email with reset link

### Export Newsletter List
1. Marketing → Newsletter
2. Apply filters as needed
3. Click "Export CSV"
4. CSV downloads with filtered data

### Add Manual Subscriber
1. Marketing → Newsletter
2. Click "Add subscriber"
3. Enter email (required) and name (optional)
4. Click "Add subscriber"

## Files Modified/Created

**New Pages:**
- `src/app/dashboard/settings/users/page.tsx`
- `src/app/dashboard/marketing/newsletter/page.tsx`

**New Components:**
- `src/components/shared/UserManagementTable.tsx`
- `src/components/shared/UserEditForm.tsx`
- `src/components/shared/NewsletterTable.tsx`

**New API Routes:**
- `src/app/api/admin/users/update/route.ts`
- `src/app/api/admin/users/reset-password/route.ts`

**Updated:**
- `src/types/database.ts` (added types)
- `src/app/dashboard/settings/page.tsx` (added link)
- `src/app/dashboard/marketing/page.tsx` (added link)

**Database:**
- `supabase/migrations/015_user_management.sql`

## Notes

- All user management requires admin role
- Newsletter management requires manager or admin role
- Activity log is append-only (no deletes)
- Soft delete pattern used (suspended_at)
- All timestamps are ISO 8601 (timestamptz in Postgres)
- Export includes only filtered/visible data
