-- ============================================================
-- 559 Flawless — 071: money arrives more ways than two
--
-- The studio takes Zelle, Venmo, PayPal, Cash App, Apple Pay Cash, and cash
-- at the counter — and the ledger's method column only knew 'cash', 'card',
-- 'gift_card', 'package', 'other'. So every app-to-app payment was filed as
-- "other", and the day's takings could not say which app the money actually
-- lives in. The constraint widens; nothing else changes.
--
-- What deliberately does NOT change:
--   * record_payment (025) passes p_method through untouched — the table
--     constraint is its gate, so widening here widens it too.
--   * The loyalty trigger (067) excludes 'package' and 'gift_card' — credit
--     being spent. Every new method is real money arriving and earns points,
--     with no edit.
--   * Card taken on the studio's own terminal stays 'card', tap-to-pay Apple
--     Pay included. The new 'apple_pay' is for Apple Pay Cash sent
--     person-to-person, like the other app methods.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

alter table public.payments
  drop constraint if exists payments_method_check;
alter table public.payments
  add constraint payments_method_check check (method in
    ('card', 'cash', 'gift_card', 'package', 'other',
     'apple_pay', 'zelle', 'paypal', 'venmo', 'cashapp'));

alter table public.orders
  drop constraint if exists orders_payment_method_check;
alter table public.orders
  add constraint orders_payment_method_check check (
    payment_method is null or payment_method in
      ('cash', 'card', 'other', 'apple_pay', 'zelle', 'paypal', 'venmo', 'cashapp')
  );
