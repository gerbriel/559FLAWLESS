-- ============================================================
-- 559 Flawless — 011: storage buckets
--
-- Two public buckets for marketing imagery, and one PRIVATE bucket for
-- treatment photography. The private bucket is never served directly: the app
-- mints short-lived signed URLs server-side after checking the same
-- `treats_client()` rule the treatment_photos table uses.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('site',      'site',      true,  10485760,
   array['image/jpeg','image/png','image/webp','image/avif','image/svg+xml']),
  ('products',  'products',  true,  10485760,
   array['image/jpeg','image/png','image/webp','image/avif']),
  ('treatment', 'treatment', false, 20971520,
   array['image/jpeg','image/png','image/webp','image/heic']),
  ('signatures','signatures',false, 2097152,
   array['image/png','image/webp'])
on conflict (id) do nothing;

-- ── Public marketing buckets ─────────────────────────────────
create policy "public reads site assets" on storage.objects
  for select to anon, authenticated using (bucket_id = 'site');
create policy "manager writes site assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'site' and public.is_manager());
create policy "manager updates site assets" on storage.objects
  for update to authenticated using (bucket_id = 'site' and public.is_manager());
create policy "manager deletes site assets" on storage.objects
  for delete to authenticated using (bucket_id = 'site' and public.is_manager());

create policy "public reads product images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'products');
create policy "manager writes product images" on storage.objects
  for insert to authenticated with check (bucket_id = 'products' and public.is_manager());
create policy "manager updates product images" on storage.objects
  for update to authenticated using (bucket_id = 'products' and public.is_manager());
create policy "manager deletes product images" on storage.objects
  for delete to authenticated using (bucket_id = 'products' and public.is_manager());

-- ── Treatment photography (private) ──────────────────────────
-- Object paths are `<client_uuid>/<appointment_uuid>/<filename>`, so the first
-- path segment identifies the client and the policy can authorize against it
-- without a join back to treatment_photos.
create policy "client reads own treatment photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'treatment'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "treating staff read treatment photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'treatment'
    and public.treats_client(((storage.foldername(name))[1])::uuid)
  );

create policy "staff upload treatment photos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'treatment' and public.is_staff()
  );

-- Deletion is deliberately narrow: the client themselves, or an admin honoring
-- a withdrawal of consent.
create policy "client or admin deletes treatment photos" on storage.objects
  for delete to authenticated using (
    bucket_id = 'treatment'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ── Signatures (private) ─────────────────────────────────────
create policy "client reads own signature" on storage.objects
  for select to authenticated using (
    bucket_id = 'signatures'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "staff reads signatures" on storage.objects
  for select to authenticated using (
    bucket_id = 'signatures' and public.is_front_desk()
  );
create policy "authenticated writes own signature" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'signatures'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_front_desk())
  );
