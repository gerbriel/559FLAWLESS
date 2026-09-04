/**
 * Database types for 559 Flawless.
 *
 * Hand-authored to match supabase/migrations. After changing a migration,
 * regenerate the authoritative version with:
 *
 *   npx supabase gen types typescript --project-id <ref> > src/types/database.ts
 *
 * Until then this file is the contract the app compiles against.
 */

import type {
  Resource,
  ServiceResource,
  AppointmentResource,
  WaitlistEntry,
  WaitlistServiceLink,
  WaitlistSettings,
  ResourceKind,
  WaitlistStatus,
} from '@/types/resources'
import type {
  Expense,
  ExpenseCategory,
  ExpenseCategoryTotal,
  ExpenseCadence,
  ProfitSummary,
  RecurringExpense,
} from '@/types/expenses'
import type {
  StaffProfile,
  StaffCredential,
  StaffEmployment,
} from '@/types/team'
import type {
  NotificationTemplate,
  NotificationSchedule,
  NotificationQueueItem,
} from '@/types/notifications'
import type {
  BreakType,
  TimeEntry,
  TimeEntryBreak,
  TimeEntryEdit,
  TimesheetEntry,
  ReminderCandidate,
} from '@/types/timetracking'
import type {
  SchedulingPolicy,
  ProviderSchedulingSettings,
} from '@/types/scheduling'
import type {
  ClientBan,
  ClientTimelineEntry,
  AppointmentPhotoPrompt,
  ClientPhotoStatus,
} from '@/types/clientprofile'
import type {
  Membership,
  MembershipService,
  MembershipStatus,
  MembershipCharge,
  MembershipRedemption,
  ClientMembership,
} from '@/types/memberships'

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// ── Enums ─────────────────────────────────────────────────────
export type UserRole = 'client' | 'provider' | 'front_desk' | 'manager' | 'admin'

export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export type DepositStatus = 'none' | 'pending' | 'paid' | 'forfeited' | 'refunded'
export type BookingSource = 'online' | 'staff' | 'walk_in' | 'phone'
export type ThreadStatus = 'open' | 'pending' | 'resolved' | 'archived'
export type OrderStatus =
  | 'cart'
  | 'pending_payment'
  | 'paid'
  | 'fulfilling'
  | 'ready_for_pickup'
  | 'shipped'
  | 'completed'
  | 'cancelled'
  | 'refunded'
export type FulfillmentMethod = 'pickup' | 'shipping'
export type SubscriberStatus = 'active' | 'unsubscribed' | 'bounced'
export type StockReason =
  | 'received'
  | 'sold'
  | 'consumed'
  | 'adjustment'
  | 'damaged'
  | 'expired'
  | 'returned'
  | 'count_correction'
export type NotificationType =
  | 'waitlist_offer'
  | 'appointment_booked'
  | 'appointment_reminder'
  | 'appointment_changed'
  | 'appointment_cancelled'
  | 'intake_flagged'
  | 'consent_needed'
  | 'message'
  | 'order'
  | 'inventory_low'
  | 'inventory_approval'
  | 'system'

// ── Row shapes ────────────────────────────────────────────────
export type Profile = {
  id: string
  role: UserRole
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  date_of_birth: string | null
  pronouns: string | null
  age_verified_at: string | null
  marketing_opt_in: boolean
  marketing_consent_at: string | null
  sms_opt_in: boolean
  display_name: string | null
  slug: string | null
  bio: string | null
  avatar_url: string | null
  timezone: string
  accepts_online_booking: boolean
  suspended_at: string | null

  // ── Added in 014–016 ────────────────────────────────────────
  /** Set when a staff member created this account on the client's behalf. */
  created_by_staff_id: string | null
  /** Evidence for marketing consent — see marketing_consent_at above. */
  marketing_consent_ip: string | null
  terms_accepted_at: string | null
  terms_version_accepted: number | null
  privacy_accepted_at: string | null

  // ── Added in 023 ────────────────────────────────────────────
  /**
   * Set once the client has supplied what signing in cannot provide — a phone
   * number and a date of birth. Null means the "finish your profile" step is
   * still owed. Prefer deriving from the fields themselves; this is a marker,
   * not the source of truth.
   */
  profile_completed_at: string | null

  created_at: string
  updated_at: string
}

export type ServiceCategory = {
  id: number
  name: string
  slug: string
  description: string | null
  image_url: string | null
  is_intimate: boolean
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export type Service = {
  id: number
  category_id: number
  name: string
  slug: string
  description: string | null
  details: string | null
  aftercare: string | null
  image_url: string | null
  price_cents: number
  price_is_starting: boolean
  duration_minutes: number
  buffer_minutes: number
  is_intimate: boolean
  requires_age_verification: boolean
  min_age: number
  requires_consultation: boolean
  requires_intake: boolean
  /** 036: dead time mid-service when the provider is free but the room is not. */
  processing_start_minutes: number
  processing_minutes: number
  /** 036: route this service's bookings to the approval queue. */
  requires_booking_approval: boolean
  /** 039: prompt for before/after photographs on this service. */
  photo_documentation: boolean
  photo_followup_days: number
  patch_test_hours: number
  deposit_cents: number
  cancellation_window_hours: number
  is_active: boolean
  is_featured: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type ServiceAddon = {
  id: number
  name: string
  slug: string
  description: string | null
  price_cents: number
  duration_minutes: number
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export type Room = {
  id: number
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  name: string
  category_ids: number[]
  is_active: boolean
  sort_order: number
  created_at: string
}

export type ProviderService = {
  provider_id: string
  service_id: number
  price_cents: number | null
  duration_minutes: number | null
  is_active: boolean
}

export type ProviderSchedule = {
  id: number
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  provider_id: string
  day_of_week: number
  start_time: string
  end_time: string
  slot_interval_minutes: number
  is_active: boolean
  created_at: string
}

export type AvailabilityBlock = {
  id: number
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  provider_id: string
  block_date: string
  start_time: string | null
  end_time: string | null
  reason: string | null
  created_by: string | null
  /** The Google event this became, so an edit updates rather than duplicates. */
  google_event_id: string | null
  created_at: string
}

/** A durable incident record — see migration 058. Manager-read, server-written. */
export type AppError = {
  id: number
  scope: string
  message: string
  context: Json
  digest: string | null
  created_at: string
}

export type Closure = {
  id: number
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  closure_date: string
  reason: string
  created_at: string
}

/**
 * A newsletter sent through the app's own inbox. Added in 028.
 *
 * `unreachable_count` is the people on the list with no account, who had to be
 * emailed by hand — recorded so a send of "40" against a list of 200 is not
 * mistaken for full coverage.
 */
export type Broadcast = {
  id: number
  subject: string
  body: string
  audience: 'clients' | 'subscribers' | 'staff'
  sent_by: string | null
  recipient_count: number
  unreachable_count: number
  created_at: string
}

export type CalendarBusy = {
  id: number
  provider_id: string
  starts_at: string
  ends_at: string
  source: string
  synced_at: string
  /** Google's event id — unique per provider, so a re-sync updates in place. */
  external_id: string | null
  /** Event title. Shown to staff so an unexplained block is not a mystery. */
  summary: string | null
}

// ── Multi-location, added in 032 ──────────────────────────────
export type Location = {
  id: number
  name: string
  slug: string
  address_line1: string | null
  city: string | null
  state: string | null
  postal: string | null
  /** Authoritative for this site's wall-clock. Never hardcode a zone. */
  timezone: string
  phone: string | null
  email: string | null
  is_active: boolean
  sort_order: number
}

/** Staff work across sites, so this is a link table rather than a column. */
export type StaffLocation = {
  profile_id: string
  location_id: number
  is_primary: boolean
  created_at: string
}

export type ServiceLocation = {
  service_id: number
  location_id: number
  /** Integer cents, or null to charge the catalogue price. */
  price_cents_override: number | null
  is_active: boolean
}

/**
 * Stock per site. `products.stock_qty` is a trigger-maintained mirror of the
 * PRIMARY location's row — not a roll-up, so a till at a second site reads zero
 * and refuses rather than selling stock sitting in another building.
 */
export type ProductStock = {
  product_id: number
  location_id: number
  qty: number
  low_stock_threshold: number | null
  updated_at: string
}

/** A saved custom-report definition. The definition is validated against an
 *  allow-list before it ever reaches a query — see src/lib/reports/custom.ts. */
export type SavedReport = {
  id: number
  name: string
  definition: Json
  is_shared: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export type BookingSettings = {
  id: number
  min_lead_minutes: number
  max_advance_days: number
  timezone: string
  auto_confirm: boolean
  default_deposit_cents: number
  cancellation_policy: string | null
  late_policy: string | null
  updated_at: string
}

export type Appointment = {
  id: string
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  provider_id: string
  room_id: number | null
  client_id: string | null
  guest_first_name: string | null
  guest_last_name: string | null
  guest_email: string | null
  guest_phone: string | null
  starts_at: string
  ends_at: string
  buffer_minutes: number
  slot: string
  status: AppointmentStatus
  source: BookingSource
  subtotal_cents: number
  total_cents: number
  deposit_cents: number
  deposit_status: DepositStatus
  stripe_payment_intent_id: string | null
  stripe_session_id: string | null
  client_notes: string | null
  staff_notes: string | null
  cancellation_reason: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  checked_in_at: string | null
  completed_at: string | null
  age_attested_at: string | null
  consent_complete_at: string | null
  google_event_id: string | null
  reminder_sent_at: string | null
  created_by: string | null

  // ── Intake tracking, added in 023 ───────────────────────────
  /**
   * When every form this appointment requires was submitted. Null while any are
   * outstanding — the client is prompted right after booking and reminded
   * before the visit.
   */
  intake_completed_at: string | null
  intake_reminder_sent_at: string | null

  // ── Scheduling mechanics, added in 036 ──────────────────────
  /** Minute offsets of the processing gaps, as an int4multirange literal. */
  processing_windows: string
  /**
   * `slot` minus each processing gap — the provider's ACTIVE time, and what
   * the exclusion constraint now guards. Maintained by trigger; never write it.
   */
  provider_slot: string
  /** Staff-only escape hatch. A CHECK forbids it on an online booking. */
  allows_overlap: boolean
  overlap_reason: string | null
  overlap_authorized_by: string | null
  approval_reason: string | null

  // ── Membership benefit, added in 050 ────────────────────────
  /** Which membership paid for part of this visit, if any. */
  client_membership_id: number | null
  /** List value of the lines an included session covered, integer cents. */
  membership_covered_cents: number
  /** The member percentage off the rest of the visit, integer cents. */
  membership_discount_cents: number

  // ── Promotions, added in 068 ────────────────────────────────
  /** Visit-level promo money (new-client %, applied referral reward), cents. */
  promo_discount_cents: number

  created_at: string
  updated_at: string
}

export type AppointmentService = {
  id: number
  appointment_id: string
  service_id: number | null
  addon_id: number | null
  name_snapshot: string
  price_cents: number
  duration_minutes: number
  sort_order: number

  // ── Pair deal, added in 067 ─────────────────────────────────
  /** List price before a pair or promo discount, integer cents. Null = undiscounted. */
  full_price_cents: number | null
  /** Which pair deal cut this line's price, if any. */
  pair_discount_id: number | null
  /** Which promotion (068) cut this line's price, if any. */
  promotion_id: number | null
  /** Staff member who added this line in the chair. Null = came with the booking. */
  added_by: string | null
  /** When a line was added after booking. Null = came with the booking. */
  added_at: string | null
}

export type ClientRecord = {
  client_id: string
  fitzpatrick: number | null
  skin_type: string | null
  concerns: string[]
  allergies: string | null
  medications: string | null
  medical_notes: string | null
  referral_source: string | null
  preferred_provider_id: string | null
  first_visit_at: string | null
  last_visit_at: string | null
  visit_count: number
  no_show_count: number
  cancel_count: number
  lifetime_value_cents: number
  photo_release_at: string | null
  photo_release_revoked_at: string | null
  created_at: string
  updated_at: string
}

export type ClientNote = {
  id: number
  client_id: string
  appointment_id: string | null
  author_id: string | null
  body: string
  products_used: string | null
  next_visit_plan: string | null
  created_at: string
  updated_at: string
}

export type ConsentForm = {
  id: number
  slug: string
  version: number
  title: string
  body: string
  service_ids: number[]
  category_ids: number[]
  requires_initials: boolean
  revalidate_after_days: number
  is_active: boolean
  created_at: string
}

export type ConsentSignature = {
  id: number
  consent_form_id: number
  client_id: string
  appointment_id: string | null
  signed_name: string
  signature_data: string | null
  body_snapshot: string
  form_version: number
  ip_address: string | null
  user_agent: string | null
  signed_at: string
  expires_at: string | null
}

export type IntakeQuestion = {
  id: string
  label: string
  type: 'boolean' | 'text' | 'select' | 'multiselect'
  options?: string[]
  flag_when?: boolean
}

export type IntakeForm = {
  id: number
  slug: string
  version: number
  title: string
  questions: IntakeQuestion[]
  service_ids: number[]
  category_ids: number[]
  is_active: boolean
  created_at: string
}

export type IntakeSubmission = {
  id: number
  intake_form_id: number
  client_id: string
  appointment_id: string | null
  answers: Record<string, Json>
  flags: string[]
  reviewed_by: string | null
  reviewed_at: string | null
  review_notes: string | null
  submitted_at: string
}

export type PatchTest = {
  id: number
  client_id: string
  service_id: number | null
  product: string | null
  performed_at: string
  performed_by: string | null
  result: 'pending' | 'pass' | 'fail'
  reaction_notes: string | null
  expires_at: string | null
}

export type TreatmentPhoto = {
  id: number
  client_id: string
  appointment_id: string | null
  storage_path: string
  phase: 'before' | 'after' | 'progress'
  body_area: string | null
  taken_at: string
  taken_by: string | null
  notes: string | null
  consent_given: boolean
  marketing_consent: boolean
  deletion_requested_at: string | null
  created_at: string
}

export type MessageThread = {
  id: string
  subject: string
  client_id: string | null
  guest_name: string | null
  guest_email: string | null
  guest_phone: string | null
  appointment_id: string | null
  assigned_to: string | null
  status: ThreadStatus
  last_message_at: string
  last_message_from: string | null
  staff_unread: boolean
  client_unread: boolean
  created_at: string
  updated_at: string
}

export type Message = {
  id: number
  thread_id: string
  sender_id: string | null
  sender_name: string | null
  body: string
  is_internal: boolean
  attachments: Json
  created_at: string
}

export type Notification = {
  id: number
  user_id: string
  type: NotificationType
  title: string
  body: string | null
  link: string | null
  appointment_id: string | null
  thread_id: string | null
  read_at: string | null
  /** When the email mirror sent it (072). Null = still owed an email. */
  emailed_at: string | null
  created_at: string
}

export type Product = {
  id: number
  sku: string
  /**
   * The GTIN printed on the packaging (UPC-A / EAN-13 / EAN-8 / ITF-14),
   * digits only. Distinct from `sku`, which is the studio's own code.
   * Added in 040.
   */
  barcode: string | null
  name: string
  slug: string
  category_id: number | null
  brand_id: number | null
  description: string | null
  ingredients: string | null
  how_to_use: string | null
  image_url: string | null
  gallery: Json
  price_cents: number
  cost_cents: number
  taxable: boolean
  is_retail: boolean
  is_professional: boolean
  /** Set = fulfilled by the Rhonda Allison marketplace; links out, no cart. */
  external_url: string | null
  unit: string
  stock_qty: number
  low_stock_threshold: number
  reorder_qty: number
  is_active: boolean
  is_featured: boolean
  sort_order: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type ProductCategory = {
  id: number
  name: string
  slug: string
  description: string | null
  image_url: string | null
  sort_order: number
  is_active: boolean
  created_at: string
}

export type InventoryLog = {
  id: number
  /** Where the movement happened. Added in 032. */
  location_id: number
  product_id: number
  change_qty: number
  balance_after: number | null
  reason: StockReason
  note: string | null
  appointment_id: string | null
  order_id: number | null
  changed_by: string | null
  created_at: string
}

export type InventoryChangeRequest = {
  id: number
  entry_type: 'stock_qty' | 'price' | 'record'
  target_table: string | null
  operation: 'create' | 'update' | 'archive' | 'restore' | null
  target_id: number | null
  old_value: number | null
  new_value: number | null
  payload: Json
  summary: string
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  requested_by: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
}

export type Order = {
  id: number
  /** Which studio. Added in 032; defaults to the primary location. */
  location_id: number
  order_number: string | null
  client_id: string | null
  guest_email: string | null
  guest_phone: string | null
  guest_name: string | null
  status: OrderStatus
  fulfillment: FulfillmentMethod
  subtotal_cents: number
  discount_cents: number
  tax_cents: number
  shipping_cents: number
  total_cents: number
  gift_card_id: number | null
  promo_code: string | null
  ship_name: string | null
  ship_line1: string | null
  ship_line2: string | null
  ship_city: string | null
  ship_state: string | null
  ship_postal: string | null
  stripe_session_id: string | null
  stripe_payment_intent_id: string | null
  paid_at: string | null
  sold_by: string | null
  appointment_id: string | null
  notes: string | null
  /** 'online' = bought through Stripe; 'in_store' = rung up at the desk. */
  channel: 'online' | 'in_store'
  /** Only set for in_store sales — an online order pays through Stripe. */
  payment_method:
    | 'cash' | 'card' | 'other'
    | 'apple_pay' | 'zelle' | 'paypal' | 'venmo' | 'cashapp'
    | null
  staff_notes: string | null
  created_at: string
  updated_at: string
}

export type OrderItem = {
  id: number
  order_id: number
  product_id: number | null
  /**
   * What the unit cost the studio, captured at sale by a trigger (043) — the
   * cost counterpart to unit_price_cents. Null on rows written before 043;
   * report code falls back to products.cost_cents and says that it did.
   */
  cost_snapshot_cents: number | null
  name_snapshot: string
  sku_snapshot: string | null
  unit_price_cents: number
  qty: number
  line_total_cents: number
}

/**
 * Who an announcement is shown to. Stored as jsonb so the shape can grow
 * without a migration; see the column comment in 014.
 */
export type AnnouncementAudience =
  | { type: 'all' }
  | { type: 'anonymous' }
  | { type: 'authenticated' }
  | { type: 'role'; roles: UserRole[] }
  | { type: 'clients'; client_ids: string[] }

export type Announcement = {
  id: number
  title: string
  body: string | null
  link_url: string | null
  link_label: string | null
  variant: 'info' | 'promo' | 'urgent'
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  created_at: string
  /** Added in 014. */
  target_audience: AnnouncementAudience
  /** Page paths this shows on. Empty = everywhere. Supports `/account/*`. */
  target_pages: string[]
  /** Higher shows first when several match. */
  priority: number

  // ── Presentation, added in 018 ──────────────────────────────
  display_style: 'banner' | 'modal' | 'corner' | 'inline'
  image_url: string | null
  dismissible: boolean
  /** session = back next visit; persist = stays closed; never = always shows. */
  dismiss_scope: 'session' | 'persist' | 'never'
  /** Modal and corner only: seconds to wait before appearing. */
  delay_seconds: number

  // ── Custom colours, added in 021 ────────────────────────────
  /** #RRGGBB overriding the variant preset, or null to use the preset. */
  background_color: string | null
  text_color: string | null
}

// ── Added in 014–016 ──────────────────────────────────────────
export type SettingType = 'policy' | 'script' | 'config' | 'content'

export type SiteSetting = {
  id: number
  key: string
  type: SettingType
  version: number
  value: Json
  text_value: string | null
  script_position: 'head_start' | 'head_end' | 'body_start' | 'body_end' | null
  script_provider: string | null
  label: string | null
  description: string | null
  help_text: string | null
  effective_at: string | null
  superseded_at: string | null
  is_active: boolean
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type ClientPageVisit = {
  id: number
  session_id: string
  client_id: string | null
  page_path: string
  page_title: string | null
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  user_agent: string | null
  ip_address: string | null
  event_type: string | null
  event_data: Json
  created_at: string
}

export type UserActivityLog = {
  id: number
  user_id: string
  action: string
  details: Json
  performed_by: string | null
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

export type ConsentAuditLog = {
  id: number
  profile_id: string | null
  email: string
  event_type: string
  ip_address: string | null
  user_agent: string | null
  source: string | null
  metadata: Json
  created_at: string
}

export type NewsletterSubscription = {
  id: number
  email: string
  profile_id: string | null
  is_subscribed: boolean
  confirmed_at: string | null
  confirmation_token: string | null
  confirmation_sent_at: string | null
  subscribed_at: string
  subscribed_ip: string | null
  subscribed_user_agent: string | null
  unsubscribed_at: string | null
  unsubscribed_ip: string | null
  unsubscribe_token: string
  source: string
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  referrer: string | null
  created_at: string
  updated_at: string
}

export type ServiceFormRequirement = {
  id: number
  service_id: number
  consent_form_id: number | null
  intake_form_id: number | null
  is_required: boolean
  revalidate_days: number | null
  staff_note: string | null
  created_at: string
  updated_at: string
}

export type Testimonial = {
  id: number
  client_name: string
  service_name: string | null
  rating: number | null
  body: string
  image_url: string | null
  is_approved: boolean
  is_featured: boolean
  client_id: string | null
  appointment_id: string | null
  sort_order: number
  created_at: string
}

export type AnalyticsEvent = {
  id: number
  session_id: string
  path: string
  event: string
  referrer: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  user_role: string | null
  user_id: string | null
  meta: Json
  created_at: string
}

/**
 * The current contents of a visitor's shopping bag, one row per analytics
 * session, overwritten in place — a snapshot, not a log. Written only through
 * `upsert_cart_snapshot()`; staff-read; sweeps itself at 30 days. See
 * migration 060.
 */
export type CartSnapshot = {
  session_id: string
  /** Stamped from auth.uid() by the write function, never from a parameter. */
  client_id: string | null
  /** [{ productId, qty }] — product ids and quantities ONLY, never prices. */
  lines: Json
  updated_at: string
}

export type SiteContent = {
  key: string
  value: Json
  label: string | null
  updated_by: string | null
  updated_at: string
}

export type BusinessHours = {
  /** Part of the primary key since 032 — hours are per studio. */
  location_id: number
  day_of_week: number
  opens_at: string | null
  closes_at: string | null
  is_closed: boolean
}

export type Faq = {
  id: number
  question: string
  answer: string
  category: string | null
  sort_order: number
  is_active: boolean
}

export type ServicePackage = {
  id: number
  name: string
  slug: string
  description: string | null
  service_id: number | null
  session_count: number
  price_cents: number
  valid_days: number
  is_active: boolean
  sort_order: number
}

export type ClientPackage = {
  id: number
  client_id: string
  package_id: number
  sessions_total: number
  sessions_remaining: number
  purchased_at: string
  expires_at: string | null
  order_id: number | null
}

/**
 * One session spent, against one appointment.
 *
 * `unique (appointment_id, client_package_id)` in 008 is what stops a single
 * visit eating two sessions of the same balance; nothing in the app checks
 * first, it inserts and reads 23505 back. `sessions_remaining` on the parent
 * row is decremented separately — 008 ships no trigger tying the two together.
 */
export type PackageRedemption = {
  id: number
  client_package_id: number
  appointment_id: string
  redeemed_at: string
}

export type GiftCard = {
  id: number
  code: string
  initial_cents: number
  balance_cents: number
  purchased_by: string | null
  recipient_name: string | null
  recipient_email: string | null
  message: string | null
  issued_at: string
  expires_at: string | null
  is_active: boolean
}

export type Payment = {
  id: number
  amount_cents: number
  method:
    | 'card' | 'cash' | 'gift_card' | 'package' | 'other'
    | 'apple_pay' | 'zelle' | 'paypal' | 'venmo' | 'cashapp'
  kind: 'deposit' | 'service' | 'product' | 'gift_card' | 'package' | 'refund'
  order_id: number | null
  appointment_id: string | null
  client_id: string | null
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  status: 'pending' | 'succeeded' | 'failed' | 'refunded'
  processed_by: string | null
  note: string | null
  created_at: string
}

export type ServiceAddonLink = {
  service_id: number
  addon_id: number
}

// ── Loyalty & pair deals, added in 067 ────────────────────────

/**
 * Book the trigger service and the discounted service in one visit, and the
 * discounted one is percent_off cheaper. Applied server-side in priceService();
 * the result freezes into `appointment_services` like every other price.
 */
export type ServicePairDiscount = {
  id: number
  trigger_service_id: number
  discounted_service_id: number
  percent_off: number
  /** Client-facing copy for the service card. */
  label: string
  is_active: boolean
  created_at: string
}

// ── Promotions & referrals, added in 068 ──────────────────────

export type PromotionKind =
  | 'service_sale'
  | 'second_service'
  | 'product_multibuy'
  | 'new_client'
  | 'referral'

/**
 * One running deal on the board. Which value fields matter depends on `kind`;
 * the engine reads what its kind needs and the admin form offers only those.
 */
export type Promotion = {
  id: number
  name: string
  kind: PromotionKind
  percent_off: number | null
  amount_cents: number | null
  sale_price_cents: number | null
  min_items: number | null
  service_ids: number[]
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

/** One applied deal — who, where, how much came off. Name is a snapshot. */
export type PromotionRedemption = {
  id: number
  promotion_id: number | null
  promotion_name: string
  client_id: string | null
  appointment_id: string | null
  order_id: number | null
  discount_cents: number
  created_at: string
}

export type ReferralCode = {
  code: string
  client_id: string
  created_at: string
}

/**
 * One person a code brought in. The referrer's reward rides the row: pending
 * when the friend books, earned when their first visit completes fully paid
 * (069, decided by DB trigger), applied when the desk takes it off a visit.
 */
export type ReferralRedemption = {
  id: number
  code: string
  referrer_id: string
  referred_client_id: string
  appointment_id: string | null
  reward_cents: number | null
  reward_percent: number | null
  reward_status: 'pending' | 'earned' | 'applied' | 'void'
  applied_appointment_id: string | null
  created_at: string
  applied_at: string | null
}

/**
 * Loyalty points, one row per movement — the balance is the sum, never stored.
 * `earned`/`reversal` rows mirror `payments` 1:1 via trigger; `adjustment`
 * rows are manager goodwill or corrections.
 */
export type LoyaltyLedgerEntry = {
  id: number
  client_id: string
  points: number
  kind: 'earned' | 'reversal' | 'adjustment'
  payment_id: number | null
  note: string | null
  created_by: string | null
  created_at: string
}

export type ServiceConsumable = {
  service_id: number
  product_id: number
  qty: number
}

export type Brand = {
  id: number
  name: string
  slug: string
  logo_url: string | null
  is_active: boolean
}

export type AppointmentEvent = {
  id: number
  appointment_id: string
  event: string
  from_status: AppointmentStatus | null
  to_status: AppointmentStatus | null
  actor_id: string | null
  detail: string | null
  created_at: string
}

export type ClientTag = {
  id: number
  name: string
  /** 039: what the tag means, shown to staff on the client record. */
  description: string | null
  sort_order: number
  /** 039: surfaces prominently — "allergic to lidocaine", not "likes tea". */
  is_alert: boolean
  color: string
  created_at: string
}

export type ClientTagLink = {
  client_id: string
  tag_id: number
}

export type NewsletterSubscriber = {
  id: number
  email: string
  first_name: string | null
  status: SubscriberStatus
  source: string | null
  client_id: string | null
  unsubscribe_token: string
  subscribed_at: string
  unsubscribed_at: string | null
  consent_ip: string | null
  consent_user_agent: string | null
  preferences: Json
}

export type Vendor = {
  id: number
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  website: string | null
  account_number: string | null
  notes: string | null
  is_active: boolean
  created_at: string
}

export type PurchaseOrder = {
  id: number
  po_number: string
  vendor_id: number | null
  status: 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled'
  ordered_at: string | null
  expected_at: string | null
  received_at: string | null
  subtotal_cents: number
  shipping_cents: number
  tax_cents: number
  total_cents: number
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type PurchaseOrderItem = {
  id: number
  po_id: number
  product_id: number | null
  name_snapshot: string
  qty_ordered: number
  qty_received: number
  unit_cost_cents: number
}

export type CalendarConnection = {
  provider_id: string
  google_email: string | null
  calendar_id: string
  /**
   * AES-256-GCM, encrypted in the route handler before it ever reaches the
   * database. Nothing reads these through PostgREST — only the service-role
   * client in src/lib/google-calendar.ts, which decrypts them there.
   */
  access_token_enc: string | null
  refresh_token_enc: string | null
  expires_at: string | null
  revoked_at: string | null

  // ── Added in 027 ────────────────────────────────────────────
  last_synced_at: string | null
  last_sync_error: string | null
  /** Put this studio's bookings into the provider's Google Calendar. */
  push_appointments: boolean
  /** Let the provider's own calendar entries block bookable slots. */
  pull_busy: boolean

  created_at: string
  updated_at: string
}

// ── Added in 030 ──────────────────────────────────────────────
/**
 * Which records survive an account deletion.
 *
 * Every one of these is a legal call rather than a technical one, and every
 * default is the conservative (retain) choice. Changing one is a decision for
 * the studio and its insurer — see the comments in 030_account_deletion.sql.
 */
export type AccountDeletionPolicy = {
  id: number
  /** Signed name, drawn signature, and the IP/user agent captured at signing. */
  scrub_consent_signature_identity: boolean
  /** fitzpatrick, skin_type, concerns, allergies, medications, medical_notes. */
  scrub_client_record_clinical: boolean
  /** Provider SOAP notes tied to a visit. */
  scrub_treatment_notes: boolean
  /** Notes with no appointment attached — not treatment records. Default true. */
  scrub_unlinked_notes: boolean
  /** consent_audit_log.email, which is the evidence the log exists to hold. */
  scrub_consent_audit_email: boolean
  updated_at: string
}

/**
 * One row per anonymised account, so "did someone delete their data?" is
 * answerable without keeping the data. Deliberately holds no FK to `profiles`
 * — it is meant to outlive the row it names.
 */
export type DeletedAccount = {
  profile_id: string
  deleted_at: string
  requested_by: 'self' | 'admin'
  /** The admin who actioned a phoned-in request; null when self-served. */
  performed_by: string | null
  /** Counts only, never content. */
  kept: Json
  removed: Json
  /** False means the API route still has to scrub GoTrue through the admin API. */
  auth_scrubbed: boolean
  /** Private-bucket objects awaiting deletion; SQL cannot reach object storage. */
  pending_storage_paths: string[]
  storage_purged_at: string | null
}

/** What `anonymise_account()` hands back. */
export type AnonymiseAccountResult = {
  status: 'anonymised'
  profile_id: string
  requested_by: 'self' | 'admin'
  /** Counts of the records the studio is keeping. */
  kept: Record<string, number>
  /** Counts of what was deleted or overwritten. */
  removed: Record<string, number>
  auth_scrubbed: boolean
  /** Treatment-photo objects the caller must now remove from the bucket. */
  storage_paths: string[]
}

// ── Added in 031 ──────────────────────────────────────────────
/**
 * A one-time bearer credential: whoever holds the link may claim exactly the
 * account described here, once, before it expires.
 *
 * `token_hash` is sha256(token) as lowercase hex — the plaintext token is
 * never stored, so this row cannot be turned back into a working link.
 */
export type Invitation = {
  id: number
  email: string
  first_name: string | null
  last_name: string | null
  note: string | null
  role: UserRole
  invited_by: string
  token_hash: string
  expires_at: string
  accepted_at: string | null
  accepted_by: string | null
  revoked_at: string | null
  revoked_by: string | null
  created_at: string
  updated_at: string

  /**
   * Added in 051. The stub this invitation is for, when it was sent to
   * somebody already on the studio's list. Accepting it claims that stub
   * instead of leaving a second record for the same person. 053 constrains it
   * to `role = 'client'` — a stub is a client, never a staff account.
   */
  client_stub_id: number | null
}

// ── Added in 051 ──────────────────────────────────────────────
/**
 * Somebody the studio knows who has no account: a name, whatever contact
 * details exist, and a note. Deliberately not a profile and deliberately
 * holding no clinical data — see the header of 051.
 *
 * Its whole life is to stop being one. `claimed_by` is set by
 * `claim_client_stub()` when an invitation carrying this stub is accepted,
 * and from then on the row is history rather than a to-do.
 */
export type ClientStub = {
  id: number
  first_name: string
  last_name: string | null
  email: string | null
  phone: string | null
  /** Free text the studio pasted in. Not clinical, and never shown publicly. */
  note: string | null
  source: 'manual' | 'import' | 'walk_in'
  /** The import run that created the row; null for anything typed by hand. */
  import_batch: string | null
  claimed_by: string | null
  claimed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ── Permissions and commissions, added in 034 ────────────────
export type Permission = {
  key: string
  label: string
  description: string
  category: string
  /** Admin-only to grant, whatever else the studio configures. */
  is_sensitive: boolean
  sort_order: number
}

export type RolePermission = {
  role: UserRole
  permission: string
}

export type StaffPermission = {
  id: number
  profile_id: string
  permission: string
  /** true grants what the role withholds; false takes away what it gives. */
  granted: boolean
  reason: string | null
  /** Null only once that account is gone; required on every write. */
  granted_by: string | null
  created_at: string
  updated_at: string
}

/** Rates are basis points so nothing here is ever a float: 4000 is 40.00%. */
export type CommissionPlan = {
  id: number
  name: string
  description: string | null
  service_rate_bp: number
  retail_rate_bp: number
  service_flat_cents: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export type CommissionCategoryRate = {
  plan_id: number
  category_id: number
  rate_bp: number | null
  flat_cents: number | null
}

export type CommissionServiceRate = {
  plan_id: number
  service_id: number
  rate_bp: number | null
  flat_cents: number | null
}

export type CommissionTier = {
  id: number
  plan_id: number
  applies_to: 'service' | 'retail'
  min_period_cents: number
  rate_bp: number
}

export type StaffCommissionPlan = {
  id: number
  profile_id: string
  plan_id: number
  location_id: number
  /** Wall-clock dates in the location's zone — 'YYYY-MM-DD'. */
  effective_from: string
  effective_to: string | null
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}


      // ── Added in 034 ────────────────────────────────────────

// ── Supabase client contract ──────────────────────────────────
/**
 * Columns Postgres fills in itself, so they're optional on insert. Keeping the
 * list here (rather than per table) is a deliberate simplification — swap it
 * for generated types when the schema settles.
 */
type Generated = 'id' | 'created_at' | 'updated_at'

/**
 * One foreign key, in the shape postgrest-js's select-query parser expects.
 * Without these, an embedded select (`services(name)`) can't be resolved and
 * the whole query result degrades to a SelectQueryError.
 */
type Rel<
  Name extends string,
  Cols extends string[],
  Ref extends string,
  RefCols extends string[],
  OneToOne extends boolean = false,
> = {
  foreignKeyName: Name
  columns: Cols
  isOneToOne: OneToOne
  referencedRelation: Ref
  referencedColumns: RefCols
}

type TableDef<
  Row,
  Relationships extends readonly unknown[] = [],
> = {
  Row: Row
  Insert: Omit<Partial<Row>, Generated> & Partial<Pick<Row, Extract<Generated, keyof Row>>>
  Update: Partial<Row>
  Relationships: Relationships
}

/**
 * Shorthand for an FK to profiles(id).
 *
 * The name must be the constraint name Postgres actually generates
 * (`<table>_<column>_fkey`), because that is the hint PostgREST expects when a
 * table has more than one FK to the same target — `appointments` has both
 * provider_id and client_id, so `profiles(...)` alone is ambiguous and the
 * query must say `profiles!appointments_provider_id_fkey(...)`.
 */
type ToProfile<Table extends string, Col extends string> = Rel<
  `${Table}_${Col}_fkey`,
  [Col],
  'profiles',
  ['id']
>

export type Database = {
  public: {
    Tables: {
      profiles: TableDef<Profile>
      service_categories: TableDef<ServiceCategory>
      services: TableDef<
        Service,
        [Rel<'services_category_id_fkey', ['category_id'], 'service_categories', ['id']>]
      >
      service_addons: TableDef<ServiceAddon>
      service_addon_links: TableDef<
        ServiceAddonLink,
        [
          Rel<'service_addon_links_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'service_addon_links_addon_id_fkey', ['addon_id'], 'service_addons', ['id']>,
        ]
      >
      service_consumables: TableDef<
        ServiceConsumable,
        [
          Rel<'service_consumables_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'service_consumables_product_id_fkey', ['product_id'], 'products', ['id']>,
        ]
      >
      rooms: TableDef<Room>
      provider_services: TableDef<
        ProviderService,
        [
          ToProfile<'provider_services', 'provider_id'>,
          Rel<'provider_services_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      provider_schedules: TableDef<ProviderSchedule, [ToProfile<'provider_schedules', 'provider_id'>]>
      availability_blocks: TableDef<AvailabilityBlock, [ToProfile<'availability_blocks', 'provider_id'>]>
      app_errors: TableDef<AppError>
      closures: TableDef<Closure>
      calendar_busy: TableDef<CalendarBusy, [ToProfile<'calendar_busy', 'provider_id'>]>
      calendar_connections: TableDef<CalendarConnection, [ToProfile<'calendar_connections', 'provider_id'>]>
      booking_settings: TableDef<BookingSettings>
      appointments: TableDef<
        Appointment,
        [
          ToProfile<'appointments', 'provider_id'>,
          ToProfile<'appointments', 'client_id'>,
          Rel<'appointments_room_id_fkey', ['room_id'], 'rooms', ['id']>,
        ]
      >
      appointment_services: TableDef<
        AppointmentService,
        [
          Rel<'appointment_services_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'appointment_services_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'appointment_services_addon_id_fkey', ['addon_id'], 'service_addons', ['id']>,
          Rel<'appointment_services_pair_discount_id_fkey', ['pair_discount_id'], 'service_pair_discounts', ['id']>,
          ToProfile<'appointment_services', 'added_by'>,
        ]
      >
      service_pair_discounts: TableDef<
        ServicePairDiscount,
        [
          Rel<'service_pair_discounts_trigger_service_id_fkey', ['trigger_service_id'], 'services', ['id']>,
          Rel<'service_pair_discounts_discounted_service_id_fkey', ['discounted_service_id'], 'services', ['id']>,
        ]
      >
      loyalty_ledger: TableDef<
        LoyaltyLedgerEntry,
        [
          ToProfile<'loyalty_ledger', 'client_id'>,
          ToProfile<'loyalty_ledger', 'created_by'>,
          Rel<'loyalty_ledger_payment_id_fkey', ['payment_id'], 'payments', ['id']>,
        ]
      >
      promotions: TableDef<Promotion, [ToProfile<'promotions', 'created_by'>]>
      promotion_redemptions: TableDef<
        PromotionRedemption,
        [
          Rel<'promotion_redemptions_promotion_id_fkey', ['promotion_id'], 'promotions', ['id']>,
          ToProfile<'promotion_redemptions', 'client_id'>,
          Rel<'promotion_redemptions_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'promotion_redemptions_order_id_fkey', ['order_id'], 'orders', ['id']>,
        ]
      >
      referral_codes: TableDef<ReferralCode, [ToProfile<'referral_codes', 'client_id'>]>
      // Two FKs to profiles AND two to appointments — every embed must name
      // its constraint.
      referral_redemptions: TableDef<
        ReferralRedemption,
        [
          Rel<'referral_redemptions_code_fkey', ['code'], 'referral_codes', ['code']>,
          ToProfile<'referral_redemptions', 'referrer_id'>,
          ToProfile<'referral_redemptions', 'referred_client_id'>,
          Rel<'referral_redemptions_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'referral_redemptions_applied_appointment_id_fkey', ['applied_appointment_id'], 'appointments', ['id']>,
        ]
      >
      appointment_events: TableDef<
        AppointmentEvent,
        [
          Rel<'appointment_events_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          ToProfile<'appointment_events', 'actor_id'>,
        ]
      >
      // Two FKs to profiles — any embed of this table MUST name the one it
      // means, e.g. `client_records!client_records_client_id_fkey(...)`.
      client_records: TableDef<
        ClientRecord,
        [
          ToProfile<'client_records', 'client_id'>,
          ToProfile<'client_records', 'preferred_provider_id'>,
        ]
      >
      client_notes: TableDef<
        ClientNote,
        [
          ToProfile<'client_notes', 'client_id'>,
          ToProfile<'client_notes', 'author_id'>,
          Rel<'client_notes_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      client_tags: TableDef<ClientTag>
      client_tag_links: TableDef<
        ClientTagLink,
        [
          ToProfile<'client_tag_links', 'client_id'>,
          Rel<'client_tag_links_tag_id_fkey', ['tag_id'], 'client_tags', ['id']>,
        ]
      >
      consent_forms: TableDef<ConsentForm>
      consent_signatures: TableDef<
        ConsentSignature,
        [
          ToProfile<'consent_signatures', 'client_id'>,
          Rel<'consent_signatures_consent_form_id_fkey', ['consent_form_id'], 'consent_forms', ['id']>,
          Rel<'consent_signatures_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      intake_forms: TableDef<IntakeForm>
      intake_submissions: TableDef<
        IntakeSubmission,
        [
          ToProfile<'intake_submissions', 'client_id'>,
          Rel<'intake_submissions_intake_form_id_fkey', ['intake_form_id'], 'intake_forms', ['id']>,
          Rel<'intake_submissions_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      patch_tests: TableDef<
        PatchTest,
        [
          ToProfile<'patch_tests', 'client_id'>,
          Rel<'patch_tests_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      treatment_photos: TableDef<
        TreatmentPhoto,
        [
          ToProfile<'treatment_photos', 'client_id'>,
          Rel<'treatment_photos_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      message_threads: TableDef<
        MessageThread,
        [
          ToProfile<'message_threads', 'client_id'>,
          ToProfile<'message_threads', 'assigned_to'>,
          Rel<'message_threads_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      messages: TableDef<
        Message,
        [
          Rel<'messages_thread_id_fkey', ['thread_id'], 'message_threads', ['id']>,
          ToProfile<'messages', 'sender_id'>,
        ]
      >
      notifications: TableDef<
        Notification,
        [
          ToProfile<'notifications', 'user_id'>,
          Rel<'notifications_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'notifications_thread_id_fkey', ['thread_id'], 'message_threads', ['id']>,
        ]
      >
      product_categories: TableDef<ProductCategory>
      brands: TableDef<Brand>
      products: TableDef<
        Product,
        [
          Rel<'products_category_id_fkey', ['category_id'], 'product_categories', ['id']>,
          Rel<'products_brand_id_fkey', ['brand_id'], 'brands', ['id']>,
        ]
      >
      inventory_log: TableDef<
        InventoryLog,
        [
          Rel<'inventory_log_product_id_fkey', ['product_id'], 'products', ['id']>,
          ToProfile<'inventory_log', 'changed_by'>,
        ]
      >
      inventory_change_requests: TableDef<
        InventoryChangeRequest,
        [ToProfile<'inventory_change_requests', 'requested_by'>, ToProfile<'inventory_change_requests', 'reviewed_by'>]
      >
      vendors: TableDef<Vendor>
      purchase_orders: TableDef<
        PurchaseOrder,
        [Rel<'purchase_orders_vendor_id_fkey', ['vendor_id'], 'vendors', ['id']>]
      >
      purchase_order_items: TableDef<
        PurchaseOrderItem,
        [
          Rel<'purchase_order_items_po_id_fkey', ['po_id'], 'purchase_orders', ['id']>,
          Rel<'purchase_order_items_product_id_fkey', ['product_id'], 'products', ['id']>,
        ]
      >
      orders: TableDef<
        Order,
        [
          ToProfile<'orders', 'client_id'>,
          Rel<'orders_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      order_items: TableDef<
        OrderItem,
        [
          Rel<'order_items_order_id_fkey', ['order_id'], 'orders', ['id']>,
          Rel<'order_items_product_id_fkey', ['product_id'], 'products', ['id']>,
        ]
      >
      announcements: TableDef<Announcement>
      testimonials: TableDef<Testimonial, [ToProfile<'testimonials', 'client_id'>]>
      analytics_events: TableDef<AnalyticsEvent, [ToProfile<'analytics_events', 'user_id'>]>
      cart_snapshots: TableDef<CartSnapshot, [ToProfile<'cart_snapshots', 'client_id'>]>
      newsletter_subscribers: TableDef<NewsletterSubscriber, [ToProfile<'newsletter_subscribers', 'client_id'>]>
      user_activity_log: TableDef<
        UserActivityLog,
        [ToProfile<'user_activity_log', 'user_id'>, ToProfile<'user_activity_log', 'performed_by'>]
      >
      site_content: TableDef<SiteContent>
      business_hours: TableDef<BusinessHours>
      faqs: TableDef<Faq>
      service_packages: TableDef<
        ServicePackage,
        [Rel<'service_packages_service_id_fkey', ['service_id'], 'services', ['id']>]
      >
      client_packages: TableDef<
        ClientPackage,
        [
          ToProfile<'client_packages', 'client_id'>,
          Rel<'client_packages_package_id_fkey', ['package_id'], 'service_packages', ['id']>,
          Rel<'client_packages_order_id_fkey', ['order_id'], 'orders', ['id']>,
        ]
      >
      package_redemptions: TableDef<
        PackageRedemption,
        [
          Rel<
            'package_redemptions_client_package_id_fkey',
            ['client_package_id'],
            'client_packages',
            ['id']
          >,
          Rel<
            'package_redemptions_appointment_id_fkey',
            ['appointment_id'],
            'appointments',
            ['id']
          >,
        ]
      >
      // ── Added in 014–016 ────────────────────────────────────
      site_settings: TableDef<
        SiteSetting,
        [ToProfile<'site_settings', 'created_by'>, ToProfile<'site_settings', 'updated_by'>]
      >
      client_page_visits: TableDef<
        ClientPageVisit,
        [ToProfile<'client_page_visits', 'client_id'>]
      >
      consent_audit_log: TableDef<
        ConsentAuditLog,
        [ToProfile<'consent_audit_log', 'profile_id'>]
      >
      newsletter_subscriptions: TableDef<
        NewsletterSubscription,
        [ToProfile<'newsletter_subscriptions', 'profile_id'>]
      >
      service_form_requirements: TableDef<
        ServiceFormRequirement,
        [
          Rel<'service_form_requirements_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'service_form_requirements_consent_form_id_fkey', ['consent_form_id'], 'consent_forms', ['id']>,
          Rel<'service_form_requirements_intake_form_id_fkey', ['intake_form_id'], 'intake_forms', ['id']>,
        ]
      >

      gift_cards: TableDef<GiftCard, [ToProfile<'gift_cards', 'purchased_by'>]>
      payments: TableDef<
        Payment,
        [
          ToProfile<'payments', 'client_id'>,
          Rel<'payments_order_id_fkey', ['order_id'], 'orders', ['id']>,
          Rel<'payments_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
        ]
      >
      broadcasts: TableDef<Broadcast, [ToProfile<'broadcasts', 'sent_by'>]>

      // ── Multi-location, added in 032 ────────────────────────
      locations: TableDef<Location>
      saved_reports: TableDef<SavedReport, [ToProfile<'saved_reports', 'created_by'>]>
      // ── Resources and waitlist, added in 037 ────────────────
      resources: TableDef<
        Resource,
        [
          Rel<'resources_location_id_fkey', ['location_id'], 'locations', ['id']>,
          Rel<'resources_room_id_fkey', ['room_id'], 'rooms', ['id']>,
        ]
      >
      service_resources: TableDef<
        ServiceResource,
        [
          Rel<'service_resources_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'service_resources_resource_id_fkey', ['resource_id'], 'resources', ['id']>,
        ]
      >
      appointment_resources: TableDef<
        AppointmentResource,
        [
          Rel<'appointment_resources_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'appointment_resources_resource_id_fkey', ['resource_id'], 'resources', ['id']>,
        ]
      >
      waitlist_settings: TableDef<WaitlistSettings>
      waitlist_entries: TableDef<
        WaitlistEntry,
        [
          Rel<'waitlist_entries_location_id_fkey', ['location_id'], 'locations', ['id']>,
          ToProfile<'waitlist_entries', 'client_id'>,
          ToProfile<'waitlist_entries', 'preferred_provider_id'>,
          Rel<'waitlist_entries_last_offer_appointment_id_fkey', ['last_offer_appointment_id'], 'appointments', ['id']>,
          Rel<'waitlist_entries_converted_appointment_id_fkey', ['converted_appointment_id'], 'appointments', ['id']>,
        ]
      >
      waitlist_services: TableDef<
        WaitlistServiceLink,
        [
          Rel<'waitlist_services_entry_id_fkey', ['entry_id'], 'waitlist_entries', ['id']>,
          Rel<'waitlist_services_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      permissions: TableDef<Permission>
      role_permissions: TableDef<
        RolePermission,
        [Rel<'role_permissions_permission_fkey', ['permission'], 'permissions', ['key']>]
      >
      staff_permissions: TableDef<
        StaffPermission,
        [
          ToProfile<'staff_permissions', 'profile_id'>,
          ToProfile<'staff_permissions', 'granted_by'>,
          Rel<'staff_permissions_permission_fkey', ['permission'], 'permissions', ['key']>,
        ]
      >
      commission_plans: TableDef<CommissionPlan, [ToProfile<'commission_plans', 'created_by'>]>
      commission_category_rates: TableDef<
        CommissionCategoryRate,
        [
          Rel<'commission_category_rates_plan_id_fkey', ['plan_id'], 'commission_plans', ['id']>,
          Rel<'commission_category_rates_category_id_fkey', ['category_id'], 'service_categories', ['id']>,
        ]
      >
      commission_service_rates: TableDef<
        CommissionServiceRate,
        [
          Rel<'commission_service_rates_plan_id_fkey', ['plan_id'], 'commission_plans', ['id']>,
          Rel<'commission_service_rates_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      commission_tiers: TableDef<
        CommissionTier,
        [Rel<'commission_tiers_plan_id_fkey', ['plan_id'], 'commission_plans', ['id']>]
      >
      // Two FKs to profiles (profile_id, created_by), so an embed has to name
      // the constraint: profiles!staff_commission_plans_profile_id_fkey(...).
      staff_commission_plans: TableDef<
        StaffCommissionPlan,
        [
          ToProfile<'staff_commission_plans', 'profile_id'>,
          ToProfile<'staff_commission_plans', 'created_by'>,
          Rel<'staff_commission_plans_plan_id_fkey', ['plan_id'], 'commission_plans', ['id']>,
          Rel<'staff_commission_plans_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >
      /**
       * Does the caller hold this permission? The per-person override wins,
       * then the role default, then no. An admin holds everything.
       */
      staff_locations: TableDef<
        StaffLocation,
        [
          ToProfile<'staff_locations', 'profile_id'>,
          Rel<'staff_locations_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >
      service_locations: TableDef<
        ServiceLocation,
        [
          Rel<'service_locations_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'service_locations_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >
      product_stock: TableDef<
        ProductStock,
        [
          Rel<'product_stock_product_id_fkey', ['product_id'], 'products', ['id']>,
          Rel<'product_stock_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >

      // ── Notification scheduling, added in 038 ───────────────
      notification_templates: TableDef<
        NotificationTemplate,
        [
          Rel<'notification_templates_location_id_fkey', ['location_id'], 'locations', ['id']>,
          ToProfile<'notification_templates', 'updated_by'>,
        ]
      >
      notification_schedules: TableDef<
        NotificationSchedule,
        [
          Rel<'notification_schedules_location_id_fkey', ['location_id'], 'locations', ['id']>,
          Rel<'notification_schedules_service_id_fkey', ['service_id'], 'services', ['id']>,
          Rel<'notification_schedules_category_id_fkey', ['category_id'], 'service_categories', ['id']>,
        ]
      >
      notification_queue: TableDef<
        NotificationQueueItem,
        [
          Rel<'notification_queue_location_id_fkey', ['location_id'], 'locations', ['id']>,
          Rel<'notification_queue_schedule_id_fkey', ['schedule_id'], 'notification_schedules', ['id']>,
          Rel<'notification_queue_template_id_fkey', ['template_id'], 'notification_templates', ['id']>,
          ToProfile<'notification_queue', 'recipient_id'>,
          Rel<'notification_queue_appointment_id_fkey', ['appointment_id'], 'appointments', ['id']>,
          Rel<'notification_queue_notification_id_fkey', ['notification_id'], 'notifications', ['id']>,
          Rel<'notification_queue_thread_id_fkey', ['thread_id'], 'message_threads', ['id']>,
        ]
      >

      // ── Time tracking, added in 035 ─────────────────────────
      break_types: TableDef<
        BreakType,
        [Rel<'break_types_location_id_fkey', ['location_id'], 'locations', ['id']>]
      >
      time_entries: TableDef<
        TimeEntry,
        [
          ToProfile<'time_entries', 'staff_id'>,
          Rel<'time_entries_location_id_fkey', ['location_id'], 'locations', ['id']>,
          Rel<'time_entries_clock_out_location_id_fkey', ['clock_out_location_id'], 'locations', ['id']>,
        ]
      >
      time_entry_breaks: TableDef<
        TimeEntryBreak,
        [
          Rel<'time_entry_breaks_time_entry_id_fkey', ['time_entry_id'], 'time_entries', ['id']>,
          Rel<'time_entry_breaks_break_type_id_fkey', ['break_type_id'], 'break_types', ['id']>,
        ]
      >
      time_entry_edits: TableDef<
        TimeEntryEdit,
        [
          Rel<'time_entry_edits_time_entry_id_fkey', ['time_entry_id'], 'time_entries', ['id']>,
          ToProfile<'time_entry_edits', 'staff_id'>,
          ToProfile<'time_entry_edits', 'edited_by'>,
        ]
      >

      // ── Scheduling mechanics, added in 036 ──────────────────
      scheduling_policies: TableDef<
        SchedulingPolicy,
        [Rel<'scheduling_policies_location_id_fkey', ['location_id'], 'locations', ['id']>]
      >
      provider_scheduling_settings: TableDef<
        ProviderSchedulingSettings,
        [
          ToProfile<'provider_scheduling_settings', 'provider_id'>,
          Rel<'provider_scheduling_settings_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >

      // ── Client bans, added in 039 ───────────────────────────
      client_bans: TableDef<
        ClientBan,
        [
          ToProfile<'client_bans', 'client_id'>,
          ToProfile<'client_bans', 'banned_by'>,
          ToProfile<'client_bans', 'lifted_by'>,
          Rel<'client_bans_location_id_fkey', ['location_id'], 'locations', ['id']>,
        ]
      >

      // ── Team profiles, added in 041 ─────────────────────────
      // Three tables, not one wide one: RLS is ROW-level, so once a role can
      // read a row it reads every column. "The internet may see the bio but not
      // the emergency contact" is only expressible by splitting them.
      staff_profiles: TableDef<StaffProfile, [ToProfile<'staff_profiles', 'profile_id'>]>
      staff_credentials: TableDef<
        StaffCredential,
        [
          ToProfile<'staff_credentials', 'profile_id'>,
          ToProfile<'staff_credentials', 'verified_by'>,
        ]
      >
      staff_employment: TableDef<
        StaffEmployment,
        [
          ToProfile<'staff_employment', 'profile_id'>,
          ToProfile<'staff_employment', 'updated_by'>,
        ]
      >

      // ── Expenses, added in 033 ──────────────────────────────
      expense_categories: TableDef<ExpenseCategory>
      expenses: TableDef<
        Expense,
        [
          Rel<'expenses_category_id_fkey', ['category_id'], 'expense_categories', ['id']>,
          Rel<'expenses_vendor_id_fkey', ['vendor_id'], 'vendors', ['id']>,
          Rel<'expenses_purchase_order_id_fkey', ['purchase_order_id'], 'purchase_orders', ['id']>,
          Rel<'expenses_recurring_id_fkey', ['recurring_id'], 'recurring_expenses', ['id']>,
          ToProfile<'expenses', 'recorded_by'>,
        ]
      >
      recurring_expenses: TableDef<
        RecurringExpense,
        [
          Rel<'recurring_expenses_category_id_fkey', ['category_id'], 'expense_categories', ['id']>,
          Rel<'recurring_expenses_vendor_id_fkey', ['vendor_id'], 'vendors', ['id']>,
          ToProfile<'recurring_expenses', 'created_by'>,
        ]
      >

      // ── Added in 030 ────────────────────────────────────────
      // No Relationships on deleted_accounts: it carries a bare uuid rather
      // than a foreign key, precisely so it survives the row it names.
      deleted_accounts: TableDef<DeletedAccount>
      account_deletion_policy: TableDef<AccountDeletionPolicy>

      // ── Added in 031 ────────────────────────────────────────
      invitations: TableDef<
        Invitation,
        [
          ToProfile<'invitations', 'invited_by'>,
          ToProfile<'invitations', 'accepted_by'>,
          ToProfile<'invitations', 'revoked_by'>,
          // Added in 051. Named, because an embed that does not disambiguate
          // between four foreign keys resolves to a SelectQueryError.
          Rel<'invitations_client_stub_id_fkey', ['client_stub_id'], 'client_stubs', ['id']>,
        ]
      >

      // ── Added in 051 ────────────────────────────────────────
      // Two FKs to profiles (claimed_by, created_by), so an embed has to name
      // the constraint: profiles!client_stubs_claimed_by_fkey(...).
      client_stubs: TableDef<
        ClientStub,
        [ToProfile<'client_stubs', 'claimed_by'>, ToProfile<'client_stubs', 'created_by'>]
      >

      // ── Memberships, added in 050 ───────────────────────────
      // `client_memberships` has two FKs to profiles (client_id, created_by),
      // so an embed has to name the constraint:
      // profiles!client_memberships_client_id_fkey(...).
      memberships: TableDef<Membership>
      membership_services: TableDef<
        MembershipService,
        [
          Rel<'membership_services_membership_id_fkey', ['membership_id'], 'memberships', ['id']>,
          Rel<'membership_services_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      client_memberships: TableDef<
        ClientMembership,
        [
          ToProfile<'client_memberships', 'client_id'>,
          ToProfile<'client_memberships', 'created_by'>,
          Rel<'client_memberships_membership_id_fkey', ['membership_id'], 'memberships', ['id']>,
        ]
      >
      membership_redemptions: TableDef<
        MembershipRedemption,
        [
          Rel<
            'membership_redemptions_client_membership_id_fkey',
            ['client_membership_id'],
            'client_memberships',
            ['id']
          >,
          Rel<
            'membership_redemptions_appointment_id_fkey',
            ['appointment_id'],
            'appointments',
            ['id']
          >,
          Rel<'membership_redemptions_service_id_fkey', ['service_id'], 'services', ['id']>,
        ]
      >
      membership_charges: TableDef<
        MembershipCharge,
        [
          Rel<
            'membership_charges_client_membership_id_fkey',
            ['client_membership_id'],
            'client_memberships',
            ['id']
          >,
          ToProfile<'membership_charges', 'recorded_by'>,
        ]
      >
    }
    // Read-only projections. Insert/Update are deliberately absent — a view
    // that accepted writes would bypass the RLS on the tables beneath it.
    // Read-only projections, added in 039. Insert/Update are deliberately
    // absent: a writable view would bypass the RLS on the tables beneath it.
    Views: {
      client_timeline: { Row: ClientTimelineEntry; Relationships: [] }
      appointment_photo_prompts: { Row: AppointmentPhotoPrompt; Relationships: [] }
      client_photo_status: { Row: ClientPhotoStatus; Relationships: [] }
    }
    Functions: {
      /** The single entry point for changing stock. See 007_inventory.sql. */
      adjust_stock: {
        Args: {
          p_product_id: number
          p_change: number
          p_reason: StockReason
          p_note?: string | null
          p_appointment?: string | null
          /** Added in 032. Omitted = the primary location. */
          p_location?: number | null
        }
        Returns: number
      }
      /**
       * Record money taken outside Stripe — cash, the studio's own card
       * terminal, a gift card. Writes the same `payments` row the webhook
       * does, so a balance is the arithmetic across both. Added in 025.
       */
      record_payment: {
        Args: {
          p_amount_cents: number
          p_kind: 'deposit' | 'service' | 'product' | 'gift_card' | 'package' | 'refund'
          p_method?:
            | 'card' | 'cash' | 'gift_card' | 'package' | 'other'
            | 'apple_pay' | 'zelle' | 'paypal' | 'venmo' | 'cashapp'
          /** Exactly one of p_appointment / p_order. */
          p_appointment?: string | null
          p_order?: number | null
          p_note?: string | null
        }
        Returns: number
      }
      /**
       * Supersede a signed consent form with a new version. The old row keeps
       * its signatures and stays readable, which is what makes "what did this
       * person actually agree to?" answerable later. Added in 026.
       */
      publish_consent_version: {
        Args: {
          p_form_id: number
          p_title: string
          p_body: string
          p_service_ids?: number[] | null
          p_category_ids?: number[] | null
          p_revalidate_after_days?: number | null
          p_requires_initials?: boolean | null
        }
        Returns: number
      }
      /**
       * Supersede an intake form rather than mutating it. Answers are keyed by
       * question id, so changing the questions of a form somebody has already
       * filled in leaves their answers with nothing recording what was asked.
       * Added in 046.
       */
      publish_intake_version: {
        Args: {
          p_form_id: number
          p_title: string
          p_questions: Json
          p_service_ids?: number[] | null
          p_category_ids?: number[] | null
        }
        Returns: number
      }
      /** A fraction, not a percentage — 0.0835 is 8.35%. Added in 026. */
      set_sales_tax_rate: {
        Args: { p_rate: number }
        Returns: number
      }
      sales_tax_rate: {
        Args: Record<PropertyKey, never>
        Returns: number
      }
      /**
       * Replace a provider's cached busy intervals for one window with what
       * Google just reported. Windowed, so syncing next month leaves this
       * month alone. Added in 027.
       */
      replace_calendar_busy: {
        Args: {
          p_provider: string
          p_from: string
          p_to: string
          p_events: { id: string; starts_at: string; ends_at: string; summary: string | null }[]
        }
        Returns: number
      }
      /**
       * Send an in-app message to every reachable recipient — one thread each,
       * so a reply is an ordinary conversation and nobody sees anyone else's.
       * Returns { broadcast_id, sent, unreachable }. Added in 028.
       */
      send_broadcast: {
        Args: {
          p_subject: string
          p_body: string
          p_audience?: 'clients' | 'subscribers' | 'staff'
        }
        Returns: { broadcast_id: number; sent: number; unreachable: number }
      }
      /** Per-announcement views, clicks and dismissals. Manager only. Added in 028. */
      announcement_stats: {
        Args: Record<PropertyKey, never>
        Returns: {
          announcement_id: number
          views: number
          clicks: number
          dismissals: number
          click_rate: number
        }[]
      }
      // ── Multi-location, added in 032 ────────────────────────
      default_location_id: { Args: Record<PropertyKey, never>; Returns: number }
      works_at: { Args: { p_location: number }; Returns: boolean }
      staff_location_ids: { Args: Record<PropertyKey, never>; Returns: number[] }
      my_location_id: { Args: Record<PropertyKey, never>; Returns: number }
      service_price_at: {
        Args: { p_service: number; p_location?: number | null }
        Returns: number
      }
      stock_on_hand: {
        Args: { p_product_id: number; p_location?: number | null }
        Returns: number
      }

      // ── Notification scheduling, added in 038 ───────────────
      dispatch_notifications: {
        Args: {
          p_now?: string
          p_horizon_minutes?: number
          p_lookback_minutes?: number
          p_limit?: number
        }
        Returns: Json
      }
      materialise_due_notifications: {
        Args: { p_now?: string; p_horizon_minutes?: number; p_lookback_minutes?: number }
        Returns: number
      }
      deliver_due_notifications: { Args: { p_now?: string; p_limit?: number }; Returns: Json }
      preview_notification_template: {
        Args: { p_title: string; p_body: string; p_link?: string | null; p_vars?: Json | null }
        Returns: Json
      }
      render_notification_template: { Args: { p_template: string; p_vars: Json }; Returns: string }
      notification_sample_vars: { Args: Record<PropertyKey, never>; Returns: Json }
      notify_waitlist_opening: {
        Args: {
          p_client: string
          p_entry_id: string
          p_starts_at: string
          p_service?: string | null
          p_location?: number | null
          p_opened_at?: string
        }
        Returns: number
      }
      mark_notification_sent: {
        Args: { p_queue_id: number; p_error?: string | null }
        Returns: boolean
      }

      // ── Time tracking, added in 035 ─────────────────────────
      clock_in: { Args: { p_location_id?: number | null }; Returns: number }
      clock_out: {
        Args: { p_location_id?: number | null; p_note?: string | null }
        Returns: number
      }
      start_break: { Args: { p_break_type_id: number }; Returns: number }
      end_break: { Args: Record<PropertyKey, never>; Returns: number }
      correct_time_entry: {
        Args: {
          p_entry_id: number
          p_clocked_in: string
          p_clocked_out: string | null
          p_reason: string
          p_location_id?: number | null
        }
        Returns: number
      }
      timesheet_entries: {
        Args: { p_from: string; p_to: string; p_staff?: string | null; p_location?: number | null }
        Returns: TimesheetEntry[]
      }
      worked_minutes: {
        Args: { p_staff: string; p_from: string; p_to: string; p_location?: number | null }
        Returns: number
      }
      timeclock_whole_minutes: { Args: { p_from: string; p_to: string }; Returns: number }
      time_clock_reminder_candidates: {
        Args: { p_late_in_minutes?: number; p_late_out_minutes?: number; p_orphan_hours?: number }
        Returns: ReminderCandidate[]
      }
      send_time_clock_reminders: {
        Args: { p_late_in_minutes?: number; p_late_out_minutes?: number; p_orphan_hours?: number }
        Returns: number
      }

      // ── Scheduling mechanics, added in 036 ──────────────────
      provider_scheduling_config: {
        Args: { p_provider: string; p_location?: number | null }
        Returns: {
          location_id: number
          min_gap_minutes: number
          max_gap_minutes: number | null
          min_fragment_minutes: number
          allow_processing_overlap: boolean
        }[]
      }
      provider_busy_segments: {
        Args: { p_provider: string; p_from: string; p_to: string }
        Returns: { starts_at: string; ends_at: string; is_processing: boolean }[]
      }
      provider_home_location_id: { Args: { p_provider: string }; Returns: number }
      booking_review_reason: {
        Args: {
          p_client_id: string | null
          p_guest_email: string | null
          p_guest_phone: string | null
          p_service_ids?: number[] | null
          p_location_id?: number | null
        }
        Returns: string | null
      }
      booking_review_label: { Args: { p_reason: string | null }; Returns: string }

      // ── Scheduled jobs, added in 044 ────────────────────────
      /** What pg_cron is running, and how each job last finished. Empty when
       *  pg_cron is not enabled, which the UI shows as "not set up". */
      scheduled_job_status: {
        Args: Record<PropertyKey, never>
        Returns: {
          jobname: string
          schedule: string
          active: boolean
          last_run: string | null
          last_status: string | null
        }[]
      }

      // ── Barcodes, added in 040 ──────────────────────────────
      /** Resolve a scanned GTIN to a product id, zero-padding-insensitive. */
      product_id_for_barcode: { Args: { p_code: string }; Returns: number | null }

      // ── Client bans + photo consent, added in 039 ───────────
      client_is_banned: {
        Args: { p_client_id: string; p_location_id?: number | null }
        Returns: boolean
      }
      client_photo_consent_ok: {
        Args: { p_client_id: string; p_intimate?: boolean }
        Returns: boolean
      }

      // ── Team profiles, added in 041 ─────────────────────────
      notify_expiring_licences: { Args: Record<PropertyKey, never>; Returns: number }
      licence_status: {
        Args: { p_expires_on: string | null; p_soon_days?: number }
        Returns: string
      }
      is_listable_staff: { Args: { p_profile_id: string }; Returns: boolean }

      // ── Expenses, added in 033 ──────────────────────────────
      /** Today's date in the studio's own timezone — the SQL mirror of dateKeyInTimeZone. */
      studio_today: { Args: Record<PropertyKey, never>; Returns: string }
      recurring_expense_dates: {
        Args: {
          p_starts_on: string
          p_cadence: ExpenseCadence
          p_ends_on: string | null
          p_through: string
        }
        Returns: string[]
      }
      generate_recurring_expenses: { Args: { p_through?: string | null }; Returns: number }
      recurring_expense_next_due: { Args: { p_rule: number }; Returns: string | null }
      expense_totals: { Args: { p_from: string; p_to: string }; Returns: ExpenseCategoryTotal[] }
      profit_summary: { Args: { p_from: string; p_to: string }; Returns: ProfitSummary[] }

      has_permission: {
        Args: { p_permission: string }
        Returns: boolean
      }
      /** The same question about somebody else. Admin or manage_permissions. */
      profile_has_permission: {
        Args: { p_profile: string; p_permission: string }
        Returns: boolean
      }
      /**
       * Grant (true), revoke (false), or clear the override (null) for one
       * person. Returns what they hold afterwards. The guard trigger behind it
       * refuses a self-grant and anything the caller does not hold themselves.
       */
      set_staff_permission: {
        Args: {
          p_profile: string
          p_permission: string
          p_granted: boolean | null
          p_reason?: string | null
        }
        Returns: boolean
      }
      /** Everything a person effectively holds, and whether it came from their role. */
      effective_permissions: {
        Args: { p_profile: string }
        Returns: {
          permission: string
          label: string
          category: string
          granted: boolean
          source: 'role' | 'override'
          sort_order: number
        }[]
      }
      /** Which rate card covered this person, at this site, on this date. */
      commission_plan_on: {
        Args: { p_profile: string; p_location: number; p_on: string }
        Returns: number | null
      }
      /**
       * Commission earned on one appointment, in integer cents, priced against
       * the card in force on its own date and against money actually taken.
       * p_location defaults to the primary site.
       */
      commission_for_appointment: {
        Args: { p_appointment: string; p_location?: number | null }
        Returns: number
      }
      /** The same for a counter sale, on the goods and not the sales tax. */
      commission_for_order: {
        Args: { p_order: number; p_location?: number | null }
        Returns: number
      }
      /** Totals over a window. p_location null means every site. */
      commission_for_period: {
        Args: {
          p_profile: string
          p_from: string
          p_to: string
          p_location?: number | null
        }
        Returns: { service_cents: number; retail_cents: number; total_cents: number }[]
      }
      // ── Resources and waitlist, added in 037 ────────────────
      resource_conflicts: {
        Args: {
          p_location_id: number | null
          p_starts_at: string
          p_ends_at: string
          p_service_ids: number[]
          p_exclude_appointment?: string | null
        }
        Returns: {
          resource_id: number
          resource_name: string
          kind: ResourceKind
          capacity: number
          required: number
          peak_in_use: number
        }[]
      }
      resource_busy_intervals: {
        Args: {
          p_location_id: number | null
          p_from: string
          p_to: string
          p_service_ids: number[]
          p_exclude_appointment?: string | null
        }
        Returns: { starts_at: string; ends_at: string }[]
      }
      appointment_location_id: { Args: { p_appointment: string }; Returns: number }
      join_waitlist: {
        Args: {
          p_service_ids: number[]
          p_earliest_date: string
          p_latest_date: string
          p_provider_id?: string | null
          p_days_of_week?: number[]
          p_earliest_time?: string | null
          p_latest_time?: string | null
          p_note?: string | null
          p_client_id?: string | null
          p_location_id?: number | null
        }
        Returns: string
      }
      waitlist_matches: {
        Args: { p_appointment: string }
        Returns: {
          entry_id: string
          client_id: string
          client_name: string | null
          waiting_since: string
          status: WaitlistStatus
          offers_sent: number
        }[]
      }
      waitlist_notify_for_appointment: {
        Args: { p_appointment: string; p_limit?: number | null }
        Returns: number
      }
      waitlist_release_expired: { Args: Record<PropertyKey, never>; Returns: number }
      waitlist_sweep: { Args: Record<PropertyKey, never>; Returns: number }
      appointment_balance_cents: {
        Args: { p_appointment: string }
        Returns: number
      }
      /**
       * Points balance — the sum of the caller-visible ledger. SECURITY
       * INVOKER: RLS decides whose rows count, so a client asking about
       * someone else gets zero. Added in 067.
       */
      loyalty_balance: {
        Args: { p_client: string }
        Returns: number
      }
      /**
       * A client's referral code, minted on first ask. The only mint —
       * no insert policy exists on referral_codes. Added in 068.
       */
      get_or_create_referral_code: {
        Args: { p_client: string }
        Returns: string
      }
      order_balance_cents: {
        Args: { p_order: number }
        Returns: number
      }
      gift_card_balance: {
        Args: { p_code: string }
        Returns: { balance_cents: number; is_active: boolean; expires_at: string | null }[]
      }
      newsletter_unsubscribe: {
        Args: { p_token: string }
        Returns: boolean
      }

      // ── Added in 014–016 ────────────────────────────────────
      /** Append-only audit trail for role changes, logins, resets. */
      log_user_activity: {
        Args: {
          p_user_id: string
          p_action: string
          p_details?: Json
          p_performed_by?: string | null
          p_ip_address?: string | null
          p_user_agent?: string | null
        }
        Returns: undefined
      }
      /** Double opt-in signup; returns { ok, status, token } as jsonb. */
      subscribe_newsletter: {
        Args: {
          p_email: string
          p_source?: string
          p_utm_source?: string | null
          p_utm_medium?: string | null
          p_utm_campaign?: string | null
          p_referrer?: string | null
        }
        Returns: Json
      }
      confirm_newsletter: {
        Args: { p_token: string }
        Returns: Json
      }
      unsubscribe_newsletter: {
        Args: { p_token: string }
        Returns: Json
      }

      // ── Added in 030 ────────────────────────────────────────
      /**
       * Scrub every identifying field for one client while keeping the
       * appointments, orders, payments, signed consent and clinical records
       * the studio is obliged to retain.
       *
       * Call it with the CLIENT'S OWN session, not the service role — the
       * self-or-admin guard lives inside the function, and handing it a
       * service-role connection is what would turn that guard off. Idempotent.
       */
      anonymise_account: {
        Args: { p_client: string }
        Returns: AnonymiseAccountResult
      }

      // ── Added in 031 ────────────────────────────────────────
      /** Read an invitation by its plaintext token without exposing the table. */
      invitation_preview: {
        Args: { p_token: string }
        Returns: {
          email: string
          role: UserRole
          first_name: string | null
          last_name: string | null
          note: string | null
          invited_by_name: string | null
          expires_at: string
          status: string
        }[]
      }
      /** Claim an invitation for `p_user`; returns the role granted. */
      redeem_invitation: {
        Args: { p_token: string; p_user: string }
        Returns: UserRole
      }

      // ── Added in 051 ────────────────────────────────────────
      /**
       * Tie an imported client to the account that just accepted their
       * invitation, filling in whatever that account is missing. Returns the
       * stub id, or null if there was no such stub.
       *
       * service_role only — the one caller is POST /api/invitations/accept,
       * which has already proved the token. Calling it with an ordinary
       * session gets "permission denied for function".
       */
      claim_client_stub: {
        Args: { p_stub: number; p_profile: string }
        Returns: number | null
      }

      // ── Added in 053 ────────────────────────────────────────
      /**
       * How the caller heard about the studio. One column, on their own
       * client record, because a client may not UPDATE that table — the rest
       * of the row is their clinical history.
       */
      record_referral_source: {
        Args: { p_source: string }
        Returns: undefined
      }

      // ── Added in 055 ────────────────────────────────────────
      /**
       * Has this client ever signed in, and is an invitation outstanding for
       * them. The only way to ask anything of `auth.users` from this app:
       * booleans keyed by profile id, never a row, an address or a timestamp
       * out of that table.
       *
       * Omit `p_ids` (or pass null) for the whole client roster.
       *
       * Refuses anyone below front desk, and the reason is what the answer is
       * FOR rather than what a provider may read: 001's "staff read all
       * profiles" policy is `is_staff()`, so a provider already sees every
       * client row — 005 narrows the clinical tables, not this one. Inviting is
       * front-desk work everywhere else in this app (the gate on
       * /dashboard/clients/stubs, and `invite` in /api/clients/bulk), so the
       * boolean that only exists to decide whether to offer an invitation is
       * gated where the invitation is.
       */
      client_claim_status: {
        Args: { p_ids?: string[] | null }
        Returns: {
          profile_id: string
          /** False is the interesting one: the account was never claimed. */
          has_signed_in: boolean
          /** A live, unexpired invitation exists for their email address. */
          invitation_pending: boolean
        }[]
      }

      // ── Memberships, added in 050 ───────────────────────────
      /**
       * The benefit test: status is 'active' AND the period has not run out.
       * `membershipIsCurrent` in src/types/memberships.ts is the UI copy — it
       * hides buttons, this one is what the database believes.
       */
      membership_is_current: {
        Args: { p_status: MembershipStatus; p_period_end: string }
        Returns: boolean
      }
      /**
       * Settle one membership period. Manager only, and idempotent — a second
       * press, or a retried Stripe invoice.paid, finds it paid and stops.
       */
      mark_membership_charge_paid: {
        Args: { p_charge: number; p_method?: string; p_note?: string | null }
        Returns: number
      }
      /**
       * Advance a membership one period and raise the `due` charge for it.
       * Takes no money — nothing in this schema can. Honours
       * cancel_at_period_end by ending the membership instead.
       */
      renew_membership: {
        Args: { p_client_membership: number }
        Returns: string
      }

      // ── Added in 056 ────────────────────────────────────────
      /**
       * Delete an anonymised client row nothing tangible points at. Refuses —
       * with a sentence — when an appointment, signature, intake, photo or
       * gift card still references it. Admin only; the deleted_accounts audit
       * row survives.
       */
      /**
       * One atomic upsert per request against the fixed-window counter. True
       * while the caller is inside its budget. Fails open on bad arguments,
       * and the TypeScript caller fails open on any error. Added in 057.
       */
      /**
       * The one write path into app_errors: a durable incident record with a
       * 30-day self-sweeping retention. Service-role only. Added in 058.
       */
      log_app_error: {
        Args: { p_scope: string; p_message: string; p_context?: Json; p_digest?: string | null }
        Returns: undefined
      }
      check_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number }
        Returns: boolean
      }
      purge_empty_profile: {
        Args: { p_profile: string }
        Returns: string
      }

      // ── Added in 060 ────────────────────────────────────────
      /**
       * The one write path into cart_snapshots: upsert the current bag for
       * one analytics session. Anon-callable on purpose — a stranger's bag
       * is the point. Caps its inputs (64-char session, jsonb array, 50
       * lines, ~4KB serialized) and refuses by silently returning, never by
       * raising — a bag snapshot must not error a browsing session. An
       * empty array deletes the row. client_id is stamped from auth.uid(),
       * never from a parameter. Respect the analytics consent key before
       * calling.
       */
      upsert_cart_snapshot: {
        Args: { p_session: string; p_lines: Json }
        Returns: undefined
      }
      /**
       * Called once after sign-in: stitch the anonymous trail for this
       * session id (analytics_events, cart_snapshots) to the calling
       * account. Moves ONLY rows with a null owner — never reassigns
       * anything that already belongs to someone — and collapses the
       * caller's snapshots to the freshest one (one person, one bag).
       * Idempotent; authenticated only, raises for anon.
       */
      claim_browsing_session: {
        Args: { p_session: string }
        Returns: undefined
      }
    }
    Enums: {
      user_role: UserRole
      appointment_status: AppointmentStatus
      deposit_status: DepositStatus
      booking_source: BookingSource
      thread_status: ThreadStatus
      order_status: OrderStatus
      notification_type: NotificationType
      stock_reason: StockReason
      subscriber_status: SubscriberStatus
      membership_status: MembershipStatus
    }
    CompositeTypes: { [_ in never]: never }
  }
}

// ── Role helpers, mirrored from the SQL functions ─────────────
export const STAFF_ROLES: UserRole[] = ['provider', 'front_desk', 'manager', 'admin']

export const isStaff = (r: string | null | undefined): boolean =>
  !!r && r !== 'client' && STAFF_ROLES.includes(r as UserRole)

export const isFrontDesk = (r: string | null | undefined): boolean =>
  r === 'front_desk' || r === 'manager' || r === 'admin'

export const isManager = (r: string | null | undefined): boolean =>
  r === 'manager' || r === 'admin'

export const isAdmin = (r: string | null | undefined): boolean => r === 'admin'

export const ROLE_LABELS: Record<UserRole, string> = {
  client: 'Client',
  provider: 'Provider',
  front_desk: 'Front Desk',
  manager: 'Manager',
  admin: 'Admin',
}
