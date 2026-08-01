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
  provider_id: string
  block_date: string
  start_time: string | null
  end_time: string | null
  reason: string | null
  created_by: string | null
  created_at: string
}

export type Closure = {
  id: number
  closure_date: string
  reason: string
  created_at: string
}

export type CalendarBusy = {
  id: number
  provider_id: string
  starts_at: string
  ends_at: string
  source: string
  synced_at: string
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
  created_at: string
}

export type Product = {
  id: number
  sku: string
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
  created_at: string
  updated_at: string
}

export type OrderItem = {
  id: number
  order_id: number
  product_id: number | null
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

export type SiteContent = {
  key: string
  value: Json
  label: string | null
  updated_by: string | null
  updated_at: string
}

export type BusinessHours = {
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
  method: 'card' | 'cash' | 'gift_card' | 'package' | 'other'
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
  access_token_enc: string | null
  refresh_token_enc: string | null
  expires_at: string | null
  revoked_at: string | null
  created_at: string
  updated_at: string
}

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
    }
    // `{ [_ in never]: never }`, not `Record<string, never>` — the latter is an
    // index signature that matches EVERY key, so the client's relation lookup
    // resolves each table to `never` and every query result collapses.
    Views: { [_ in never]: never }
    Functions: {
      /** The single entry point for changing stock. See 007_inventory.sql. */
      adjust_stock: {
        Args: {
          p_product_id: number
          p_change: number
          p_reason: StockReason
          p_note?: string | null
          p_appointment?: string | null
        }
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
